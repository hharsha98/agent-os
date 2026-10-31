// Stops Windows release builds from opening a stray console window next to
// the app. Does nothing on macOS/Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Agent OS desktop shell.
//!
//! Agent OS is a Node server plus a web UI. This app does not rewrite any of
//! that in Rust: it ships its own copy of Node 24 and the bundled server,
//! starts them as a child process, waits for the server to say which port it
//! picked, then points a native window at it, already logged in.
//!
//! ```text
//!   Agent OS.app
//!     |-- this Rust shell (window, menu, quit handling, notifications)
//!     |      spawns -->  resources/node/bin/node resources/server/server.mjs
//!     |                    AGENT_OS_PORT=0  AGENT_OS_TOKEN=<random>  AGENT_OS_STATIC_DIR=...
//!     |                    AGENT_OS_STDIN_SHUTDOWN=1 (stdin stays open: the quit line)
//!     |      reads  <--  stdout "AGENT_OS_READY:<port>"
//!     |      reads  <--  stdout "AGENT_OS_ALERT:<json>"  (a session needs you: a notification
//!     |                    when the window is hidden or not focused; a click shows the window)
//!     |      opens  -->  http://127.0.0.1:<port>/?launch=<token>&desktop=1
//! ```
//!
//! The most important job here is cleanup: when the app quits, by any route,
//! the server must end every session and run it started, then stop. Because
//! sessions are the person's live work, quitting asks first through the page
//! (the quit flow, near the end of this file), and on macOS closing the window
//! only hides it.

use std::collections::VecDeque;
use std::env;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Listener, Manager, WebviewWindow};
use tauri_plugin_notification::{ActionPerformed, NotificationExt};
use url::Url;

/// What the server prints on stdout once it is listening.
const READY_LINE_PREFIX: &str = "AGENT_OS_READY:";
/// What the server prints on stdout when a session needs the person (only when it runs with
/// AGENT_OS_PACKAGED=1; server/runtime/sessions/signals.js, printAlertLine): this prefix, then
/// one line of JSON, {"sessionId","agent","kind","text"}.
const ALERT_LINE_PREFIX: &str = "AGENT_OS_ALERT:";
/// The alert kinds that raise a notification (the server prints no others).
const ALERT_KINDS: [&str; 3] = ["waiting", "approval", "limit"];
/// The longest alert text a notification shows, in characters (the server cuts it the same way).
const ALERT_TEXT_MAX: usize = 200;
/// The longest agent name a notification title shows, in characters (the server prints a short
/// fixed name; this only keeps a wrong or odd value from filling the title).
const ALERT_AGENT_MAX: usize = 40;
/// An alert line is about 2.5 KB at most (200 characters, escaped, plus the ids); a longer one is
/// not an alert and is not parsed.
const ALERT_LINE_MAX_BYTES: usize = 8 * 1024;
/// The most bytes read_lines_lossy keeps of one line. The rest of a longer line is read and
/// dropped, so one stray binary dump can neither fill memory nor stop the reader.
const LINE_MAX_BYTES: usize = 1 << 20;
/// The action the notification plugin reports for a click on the notification itself.
const NOTIFICATION_TAP: &str = "tap";
/// How long to wait for that line before showing an error.
const READY_TIMEOUT: Duration = Duration::from_secs(20);
/// How many trailing stderr lines the error page can show.
const STDERR_TAIL_LINES: usize = 20;
/// How long a quitting app waits for the server to end every session and run and
/// exit on its own before forcing it. The server's own hard limit is 8 s
/// (server/runtime/shutdown.js), so this is enough for any server that is not stuck.
const QUIT_GRACE: Duration = Duration::from_secs(10);
/// The line that asks the server to quit. The server reads its stdin only when
/// AGENT_OS_STDIN_SHUTDOWN=1 (set in spawn_server) and treats this exact line, or the
/// end of its input, like SIGTERM. It is the only graceful route on Windows, where
/// the server has no console to send a signal to.
const SHUTDOWN_LINE: &str = "AGENT_OS_SHUTDOWN\n";
/// How long the page has to say its quit question is on screen. After that no page
/// can ask, so the quit goes on.
const QUIT_SHOWN_WAIT: Duration = Duration::from_secs(2);
/// Shell -> page: the person wants to quit (no payload).
const QUIT_REQUESTED_EVENT: &str = "agentos://quit-requested";
/// Page -> shell: the quit question is on screen.
const QUIT_SHOWN_EVENT: &str = "agentos://quit-shown";
/// Page -> shell: the answer, `{ "quit": true | false }`.
const QUIT_ANSWER_EVENT: &str = "agentos://quit-answer";
/// The custom "Quit Agent OS" menu item.
const QUIT_MENU_ID: &str = "agentos-quit";
/// "Show Agent OS" in the macOS app menu: brings the hidden window back.
const SHOW_MENU_ID: &str = "agentos-show";
/// View > Reload.
const RELOAD_MENU_ID: &str = "reload";

/// The running server, shared between the window, the exit handler and the
/// signal thread. `None` once it has been shut down.
type ServerState = Arc<Mutex<Option<Child>>>;
/// Where the quit flow is (see QuitFlow).
type QuitState = Mutex<QuitFlow>;

enum ServerStartup {
    Ready(u16),
    /// stdout closed before the ready line: the server crashed. Holds the
    /// last stderr lines.
    Exited(String),
}

/// Everything needed to start the server.
struct Launch {
    node: PathBuf,
    entry: PathBuf,
    static_dir: PathBuf,
    working_dir: Option<PathBuf>,
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Finds the bundled Node and server inside the app's resources. If they are
/// missing (`cargo tauri dev` runs without a bundling step) it falls back to
/// the system `node` and the repo checkout this crate lives in.
fn resolve_launch(app: &tauri::App) -> Result<Launch, String> {
    let node_rel = if cfg!(windows) {
        "node.exe"
    } else {
        "bin/node"
    };

    if let Ok(resources) = app.path().resource_dir() {
        let node = resources.join("resources/node").join(node_rel);
        let server_dir = resources.join("resources/server");
        let entry = server_dir.join("server.mjs");
        if node.is_file() && entry.is_file() {
            return Ok(Launch {
                node,
                entry,
                static_dir: server_dir.join("web"),
                working_dir: home_dir(),
            });
        }
    }

    // Dev mode: desktop/src-tauri -> repo root.
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let entry = repo.join("server/index.js");
    if entry.is_file() {
        return Ok(Launch {
            node: PathBuf::from("node"),
            entry,
            static_dir: repo.join("dist"),
            working_dir: Some(repo),
        });
    }

    Err(
        "Couldn't find Agent OS's built-in server files. The app looks incomplete; \
         please download it again."
            .to_string(),
    )
}

/// 32 random bytes as hex. This is the per-launch login token: it is handed
/// to the server and to the window's first URL only, and never logged.
fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| format!("Couldn't create a secure login code for this session: {err}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// PATH for the server. An app opened from Finder/Explorer gets a bare PATH,
/// so without this the server could not find the agent CLIs (claude, codex,
/// hermes, ...) the user already installed. Existing directories only,
/// prepended so they win over the inherited PATH. The bundled Node is
/// deliberately NOT added: agents should keep using the user's own tools.
fn server_path_env() -> OsString {
    let mut dirs: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin"), // Homebrew, Apple Silicon
        PathBuf::from("/usr/local/bin"),    // Homebrew, Intel; manual installs
    ];
    if let Some(home) = home_dir() {
        for relative in [
            ".local/bin",
            ".agent-os/node/bin",
            ".npm-global/bin",
            ".volta/bin",
            ".cargo/bin",
            ".bun/bin",
        ] {
            dirs.push(home.join(relative));
        }
    }
    if let Some(appdata) = env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        dirs.push(local.join("Programs"));
        dirs.push(local.join("AgentOS").join("node"));
    }
    dirs.retain(|dir| dir.is_dir());

    if let Some(inherited) = env::var_os("PATH") {
        dirs.extend(env::split_paths(&inherited));
    }

    // Keep the first occurrence of each directory so prepended entries win.
    let mut seen: Vec<PathBuf> = Vec::with_capacity(dirs.len());
    dirs.retain(|dir| {
        if seen.contains(dir) {
            false
        } else {
            seen.push(dir.clone());
            true
        }
    });

    // join_paths only fails on a directory containing the separator; in that
    // odd case the untouched inherited PATH beats having none.
    env::join_paths(&dirs).unwrap_or_else(|_| env::var_os("PATH").unwrap_or_default())
}

fn spawn_server(launch: &Launch, token: &str) -> std::io::Result<Child> {
    let mut command = Command::new(&launch.node);
    command
        .arg(&launch.entry)
        // AGENT_OS_PORT=0: let the OS pick a free port, so two copies never collide.
        // An AGENT_OS_ name, not PORT: the server's environment reaches every session
        // through the login shell minus the AGENT_OS_ names, and an agent's own dev
        // server must not see PORT=0.
        .env("AGENT_OS_PORT", "0")
        .env("AGENT_OS_TOKEN", token)
        .env("AGENT_OS_STATIC_DIR", &launch.static_dir)
        .env("AGENT_OS_PACKAGED", "1")
        // The server reads its stdin for SHUTDOWN_LINE (see stop_server_within).
        .env("AGENT_OS_STDIN_SHUTDOWN", "1")
        // The PATH this app was started with (launchd's on macOS). The server starts the
        // login shell with it, so a session's PATH begins where Terminal.app's does, not
        // with the folders server_path_env adds (H2, decision Q11a).
        .env("AGENT_OS_LAUNCH_PATH", env::var_os("PATH").unwrap_or_default())
        .env("PATH", server_path_env())
        // Kept open for the server's whole life: the quit request travels through it,
        // and if this app ever dies, the pipe closes and the server shuts down by itself.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = &launch.working_dir {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command.spawn()
}

fn parse_ready_line(line: &str) -> Option<u16> {
    line.strip_prefix(READY_LINE_PREFIX)?.trim().parse().ok()
}

/// One alert from the server, read from its `AGENT_OS_ALERT:` line.
#[derive(Debug, PartialEq)]
struct AlertNote {
    /// Not shown in the notification; a line without one is not an alert.
    #[allow(dead_code)]
    session_id: String,
    agent: String,
    kind: String,
    text: String,
}

/// Reads one `AGENT_OS_ALERT:<json>` line. Anything else is not an alert: another line, broken
/// JSON, a missing or non-string field, an empty session id or agent, or a kind other than
/// waiting, approval or limit, or a line longer than ALERT_LINE_MAX_BYTES (never parsed). The text
/// is cut to 200 characters and the agent name to 40, control characters removed (characters, not
/// bytes, so no letter is split).
fn parse_alert_line(line: &str) -> Option<AlertNote> {
    if line.len() > ALERT_LINE_MAX_BYTES {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(line.strip_prefix(ALERT_LINE_PREFIX)?).ok()?;
    let field = |name: &str| -> Option<String> { value.get(name)?.as_str().map(str::to_owned) };
    let session_id = field("sessionId")?;
    let agent: String = field("agent")?.chars().filter(|c| !c.is_control()).take(ALERT_AGENT_MAX).collect();
    let kind = field("kind")?;
    let text = field("text")?;
    if session_id.is_empty() || agent.trim().is_empty() || !ALERT_KINDS.contains(&kind.as_str()) {
        return None;
    }
    Some(AlertNote {
        session_id,
        agent,
        kind,
        text: text.chars().take(ALERT_TEXT_MAX).collect(),
    })
}

/// The notification's title (both forms are new sentences for the owner's review, SP4 Q32).
fn alert_title(kind: &str, agent: &str) -> Option<String> {
    match kind {
        "waiting" | "approval" => Some(format!("{agent} is waiting for you")),
        "limit" => Some(format!("{agent}'s plan ran out")),
        _ => None,
    }
}

/// A notification only when the person is not looking at the window (spec SP4, Alerts UI): it is
/// hidden (macOS: closed with the red button, or Agent OS hidden), minimized, or another app is in
/// front. While the window is in front, the page itself shows the alert.
fn should_notify(visible: bool, focused: bool) -> bool {
    !visible || !focused
}

/// A click on the notification itself brings the window back. Agent OS's notifications carry no
/// action buttons, so a click is the only action that can arrive.
fn notification_click_shows_window(action_id: &str) -> bool {
    action_id == NOTIFICATION_TAP
}

/// Calls `each` with every line `reader` gives, without its line ending ("\n" or "\r\n"), until
/// the end of the input or a read error. Bytes that are not UTF-8 become U+FFFD instead of ending
/// the loop (SP4 ruling R21): `BufRead::lines()` stops at the first such line, and then nobody
/// drains the pipe, so a chatty server would block on a full pipe. A line longer than
/// LINE_MAX_BYTES is given to `each` as its first LINE_MAX_BYTES bytes; the rest of it is read and
/// dropped, and the next line comes as usual.
fn read_lines_lossy<R: BufRead>(mut reader: R, mut each: impl FnMut(&str)) {
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match (&mut reader).take(LINE_MAX_BYTES as u64).read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(read) => {
                if buf.last() == Some(&b'\n') {
                    buf.pop();
                    if buf.last() == Some(&b'\r') {
                        buf.pop();
                    }
                } else if read >= LINE_MAX_BYTES {
                    // Too long for one line: the rest of it is not kept.
                    skip_rest_of_line(&mut reader);
                }
                each(&String::from_utf8_lossy(&buf));
            }
        }
    }
}

/// Reads and drops everything up to and including the next "\n" (or to the end of the input).
fn skip_rest_of_line<R: BufRead>(reader: &mut R) {
    loop {
        let (found, used) = match reader.fill_buf() {
            Ok([]) => return,
            Ok(available) => match available.iter().position(|byte| *byte == b'\n') {
                Some(at) => (true, at + 1),
                None => (false, available.len()),
            },
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        };
        reader.consume(used);
        if found {
            return;
        }
    }
}

/// Reads the server's output for one startup attempt. Both pipes are drained
/// for the server's whole life: if nobody read them, a chatty server would
/// eventually block on a full pipe (or hit a broken one) and hang or crash.
/// Both are read as bytes (read_lines_lossy), so a line that is not UTF-8
/// never stops the draining (SP4 ruling R21).
/// stderr is kept as a short tail for the error page, with the login token
/// scrubbed out in case anything ever echoes it. On stdout the ready line is
/// reported once, and every alert line goes to notify_alert.
fn watch_server(
    stdout: ChildStdout,
    stderr: ChildStderr,
    token: String,
    tx: mpsc::Sender<ServerStartup>,
    app: AppHandle,
) {
    let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    {
        let tail = Arc::clone(&tail);
        let token = token.clone();
        thread::spawn(move || {
            read_lines_lossy(BufReader::new(stderr), |line| {
                let mut tail = tail.lock().unwrap();
                if tail.len() >= STDERR_TAIL_LINES {
                    tail.pop_front();
                }
                tail.push_back(line.replace(&token, "[hidden]"));
            });
        });
    }

    let mut reported = false;
    read_lines_lossy(BufReader::new(stdout), |line| {
        if !reported {
            if let Some(port) = parse_ready_line(line) {
                reported = true;
                let _ = tx.send(ServerStartup::Ready(port));
                return;
            }
        }
        if let Some(note) = parse_alert_line(line) {
            // The window check and the notification run on the main thread, so this reader
            // never waits on the window and keeps draining the server's output.
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || notify_alert(&handle, &note));
        }
    });

    if !reported {
        let text = tail
            .lock()
            .unwrap()
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        let _ = tx.send(ServerStartup::Exited(text));
    }
}

/// Shows one alert as a desktop notification, only when the person is not looking at the window
/// (should_notify). Runs on the main thread (see watch_server), where the window answers at once.
/// A notification that cannot be shown is reported on stderr and otherwise ignored: an alert must
/// never stop the app.
fn notify_alert(app: &AppHandle, note: &AlertNote) {
    let Some(title) = alert_title(&note.kind, &note.agent) else {
        return;
    };
    // A window that cannot be asked (or none at all) counts as hidden.
    let (visible, focused) = app
        .get_webview_window("main")
        .map(|window| {
            (
                window.is_visible().unwrap_or(false),
                window.is_focused().unwrap_or(false),
            )
        })
        .unwrap_or((false, false));
    if !should_notify(visible, focused) {
        return;
    }
    let mut notification = app.notification().builder().title(title);
    if !note.text.is_empty() {
        notification = notification.body(note.text.as_str());
    }
    if let Err(err) = notification.show() {
        // Not eprintln!: that panics when stderr cannot be written, and this runs on the main thread.
        let _ = writeln!(std::io::stderr(), "Agent OS couldn't show a notification: {err}");
    }
}

/// A click on one of Agent OS's notifications brings the window back (it may be hidden). The
/// plugin calls the handler on a background thread; showing the window does not wait there. It is
/// registered before the server starts, because the plugin reports clicks only on notifications
/// shown after a handler exists.
fn listen_for_notification_clicks(app: &tauri::App) {
    let handle = app.handle().clone();
    let registered = app.notification().on_action(move |performed: &ActionPerformed| {
        if notification_click_shows_window(performed.action_id()) {
            show_main_window(&handle);
        }
    });
    if let Err(err) = registered {
        // Never on desktop (the plugin says so). Notifications still show; a click then only
        // brings the app to the front.
        let _ = writeln!(std::io::stderr(), "Agent OS couldn't listen for notification clicks: {err}");
    }
}

/// Puts a plain-English message on the loading page (desktop/loading/index.html)
/// and hides its spinner. serde_json produces a correctly escaped JS string.
fn show_error(window: &WebviewWindow, message: &str) {
    let js_message =
        serde_json::to_string(message).unwrap_or_else(|_| "\"Something went wrong.\"".into());
    let script = format!(
        "(function(){{\
           var s = document.getElementById('status');\
           var sp = document.getElementById('spinner');\
           if (s) {{ s.textContent = {js_message}; s.classList.add('error'); }}\
           if (sp) {{ sp.style.display = 'none'; }}\
         }})();"
    );
    let _ = window.eval(&script);
}

/// Stops the server and waits for it, at most `grace`.
///
/// It asks through the server's stdin (every OS): it writes SHUTDOWN_LINE and closes the pipe.
/// The server then runs its own quit steps (it records every live session as ended by the quit,
/// stops all sessions and runs, and exits; its own hard limit is 8 s). If the line cannot be
/// written, unix falls back to SIGTERM at once. A server still running after `grace` is forced:
/// SIGKILL on unix, `taskkill /T /F` (the whole tree) on Windows.
///
/// Returns None when no server was running, Some(true) when it ended on its own, and
/// Some(false) when it had to be forced. Safe to call more than once: `take()` makes later
/// calls do nothing.
fn stop_server_within(state: &ServerState, grace: Duration) -> Option<bool> {
    let mut child = state.lock().ok().and_then(|mut guard| guard.take())?;

    // `stdin` is dropped at the end of this match, which closes the pipe: end of input is the
    // same request to the server.
    let asked = match child.stdin.take() {
        Some(mut stdin) => stdin
            .write_all(SHUTDOWN_LINE.as_bytes())
            .and_then(|()| stdin.flush())
            .is_ok(),
        None => false,
    };
    #[cfg(unix)]
    {
        if !asked {
            unsafe {
                libc::kill(child.id() as i32, libc::SIGTERM);
            }
        }
    }
    #[cfg(not(unix))]
    let _ = asked;

    let deadline = Instant::now() + grace;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Some(true), // ended on its own: the normal case
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            _ => break,
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .status();
    }

    let _ = child.kill();
    let _ = child.wait();
    Some(false)
}

/// Stops the server with the full QUIT_GRACE. Called from the quit flow, from the app's Exit
/// event and (unix) from the signal thread, because each covers a different way of quitting.
fn stop_server(state: &ServerState) {
    let _ = stop_server_within(state, QUIT_GRACE);
}

/// A plain `kill <pid>` on this app (or the computer logging out) skips Tauri's own
/// quit path entirely, so without this the server would be left running. It does not
/// ask first (planning decision Q5a): there may be nobody to answer, and a logout must
/// not hang on a question. The server still ends its sessions and runs on its own
/// (stop_server), then the app exits. signal-hook delivers the signal to an ordinary
/// thread (not real signal context), where taking a mutex is safe.
#[cfg(unix)]
fn install_signal_handler(state: ServerState) {
    use signal_hook::consts::{SIGINT, SIGTERM};
    use signal_hook::iterator::Signals;

    let Ok(mut signals) = Signals::new([SIGTERM, SIGINT]) else {
        return; // best effort: normal quit paths still work
    };
    thread::spawn(move || {
        if signals.forever().next().is_some() {
            stop_server(&state);
            std::process::exit(0);
        }
    });
}

fn main() {
    let server_state: ServerState = Arc::new(Mutex::new(None));

    #[cfg(unix)]
    install_signal_handler(Arc::clone(&server_state));

    let context = tauri::generate_context!();

    // The updater plugin refuses to start without a signing public key in
    // tauri.conf.json (`plugins.updater.pubkey`), and Agent OS has no key yet.
    // So register it only when one is configured; until then the update
    // banner finds no updater and stays hidden. See desktop/README.md.
    let updater_configured = context
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|cfg| cfg.get("pubkey"))
        .and_then(|key| key.as_str())
        .is_some_and(|key| !key.trim().is_empty());

    let mut builder = tauri::Builder::default()
        // The stock macOS menu has items we don't want (and a Close Window
        // entry); the custom menu in setup() replaces it.
        .enable_macos_default_menu(false)
        // relaunch() after an update the user approved.
        .plugin(tauri_plugin_process::init())
        // "Show in Finder" on the Workspace page. Only the reveal permission is
        // granted (capabilities/default.json), so a page cannot open or run files.
        .plugin(tauri_plugin_opener::init())
        // "Choose folder…" in the New session dialog. Only the open dialog is
        // granted (dialog:allow-open); it hands the page the path the person picked.
        .plugin(tauri_plugin_dialog::init())
        // Desktop notifications when a session needs you and the window is hidden or not focused.
        // Only this shell raises them (notify_alert, from the server's AGENT_OS_ALERT lines). The
        // page has no notification:* permission (capabilities/default.json), so no script in it
        // can send one (SP4 ruling R20).
        .plugin(tauri_plugin_notification::init());
    if updater_configured {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .manage(server_state)
        .manage(Mutex::new(QuitFlow::default()))
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("the \"main\" window is declared in tauri.conf.json");

            // Before the server starts: the plugin reports clicks only on notifications shown
            // after a click handler exists.
            listen_for_notification_clicks(app);
            start_server(app, &window);
            build_menu(app)?;
            listen_for_quit_answers(app);
            Ok(())
        })
        // A page that starts loading again cannot be showing an earlier quit question.
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                if let Ok(mut flow) = webview.state::<QuitState>().lock() {
                    flow.page_gone();
                }
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                // macOS: closing the window only hides it, and sessions keep running.
                // The Dock icon, or Agent OS > Show Agent OS, brings it back.
                #[cfg(target_os = "macos")]
                {
                    let _ = window.hide();
                }
                // Windows and Linux have no tray in this work, so closing the
                // window means quitting, which asks first.
                #[cfg(not(target_os = "macos"))]
                request_quit(window.app_handle());
            }
        })
        .build(context)
        .expect("error while building the Agent OS desktop app")
        .run(|app_handle, event| match event {
            // Something asked the app to exit (the last window went away, or app.exit()).
            // Unless our own quit flow already decided, it goes through the flow. An update
            // the person approved restarts the app with RESTART_EXIT_CODE, which cannot be
            // prevented: it is let through, and Exit below still stops the server first.
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                if code != Some(tauri::RESTART_EXIT_CODE) && !quit_allowed(app_handle) {
                    api.prevent_exit();
                    request_quit(app_handle);
                }
            }
            // macOS: a click on the Dock icon while the window is hidden.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main_window(app_handle),
            // The app is ending, by any route (including routes that cannot be asked
            // about, such as the Dock's Quit or logging out). Stop the server, gracefully.
            tauri::RunEvent::Exit => stop_server(&app_handle.state::<ServerState>()),
            _ => {}
        });
}

/// Starts the server and, once it reports its port, navigates the window to
/// it. Runs the waiting on background threads so the window opens at once.
fn start_server(app: &tauri::App, window: &WebviewWindow) {
    let launch = match resolve_launch(app) {
        Ok(launch) => launch,
        Err(message) => return show_error(window, &message),
    };
    let token = match new_token() {
        Ok(token) => token,
        Err(message) => return show_error(window, &message),
    };

    let mut child = match spawn_server(&launch, &token) {
        Ok(child) => child,
        Err(err) => {
            return show_error(
                window,
                &format!(
                    "Agent OS couldn't start its built-in server ({err}).\n\n\
                     Try quitting and opening Agent OS again. If that doesn't help, \
                     download the app again."
                ),
            )
        }
    };
    let stdout = child.stdout.take().expect("stdout was configured as piped");
    let stderr = child.stderr.take().expect("stderr was configured as piped");
    *app.state::<ServerState>().lock().unwrap() = Some(child);

    let (tx, rx) = mpsc::channel();
    let watch_token = token.clone();
    let watch_app = app.handle().clone();
    thread::spawn(move || watch_server(stdout, stderr, watch_token, tx, watch_app));

    let window = window.clone();
    thread::spawn(move || {
        match rx.recv_timeout(READY_TIMEOUT) {
        Ok(ServerStartup::Ready(port)) => {
            // `launch` is swapped by the server for a secure cookie, then
            // removed from the address bar by the app. `desktop=1` tells the
            // UI it is running inside the desktop app.
            let address = format!("http://127.0.0.1:{port}/?launch={token}&desktop=1");
            match Url::parse(&address) {
                Ok(url) => {
                    let _ = window.navigate(url);
                }
                Err(_) => show_error(&window, "Agent OS couldn't work out where its server is running."),
            }
        }
        Ok(ServerStartup::Exited(stderr_tail)) => show_error(
            &window,
            &format!(
                "Agent OS's built-in server stopped before it finished starting.\n\n{}",
                if stderr_tail.is_empty() {
                    "It didn't say why.".to_string()
                } else {
                    format!("What it reported:\n{stderr_tail}")
                }
            ),
        ),
        Err(_) => show_error(
            &window,
            &format!(
                "Agent OS is taking longer than {} seconds to start, so it stopped waiting.\n\n\
                 Quit and open it again. If it keeps happening, restart your computer and try once more.",
                READY_TIMEOUT.as_secs()
            ),
        ),
    }
    });
}

/// The menu.
/// - macOS: Agent OS (About, Show Agent OS, Hide ⌘H, Quit Agent OS ⌘Q), Edit (so ⌘C/⌘V work in
///   text fields), View > Reload ⌘R, Window > Minimize ⌘M.
/// - Windows and Linux: Agent OS (About, Quit Agent OS) and View > Reload, with NO keyboard
///   shortcuts at all. There a menu shortcut is a Ctrl key, and every Ctrl key belongs to the
///   agent's terminal (Ctrl+C, Ctrl+R, Ctrl+Z, Ctrl+A, ...). The predefined Edit, Minimize and
///   Hide items carry fixed Ctrl shortcuts that cannot be removed, so they are left out; the web
///   view handles copy and paste in text fields by itself. Closing the window is how you quit.
/// Quit is a custom item: the predefined one ends the app before anything can ask.
fn build_menu(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle();

    let quit = MenuItemBuilder::with_id(QUIT_MENU_ID, "Quit Agent OS");
    #[cfg(target_os = "macos")]
    let quit = quit.accelerator("CmdOrCtrl+Q");
    let quit = quit.build(handle)?;

    let reload = MenuItemBuilder::with_id(RELOAD_MENU_ID, "Reload");
    #[cfg(target_os = "macos")]
    let reload = reload.accelerator("CmdOrCtrl+R");
    let reload = reload.build(handle)?;
    let view_menu = SubmenuBuilder::new(handle, "View").item(&reload).build()?;

    #[cfg(target_os = "macos")]
    let menu = {
        let show = MenuItemBuilder::with_id(SHOW_MENU_ID, "Show Agent OS").build(handle)?;
        let app_menu = SubmenuBuilder::new(handle, "Agent OS")
            .item(&PredefinedMenuItem::about(handle, None, None)?)
            .separator()
            .item(&show)
            .item(&PredefinedMenuItem::hide(handle, None)?)
            .separator()
            .item(&quit)
            .build()?;
        let edit_menu = SubmenuBuilder::new(handle, "Edit")
            .item(&PredefinedMenuItem::undo(handle, None)?)
            .item(&PredefinedMenuItem::redo(handle, None)?)
            .separator()
            .item(&PredefinedMenuItem::cut(handle, None)?)
            .item(&PredefinedMenuItem::copy(handle, None)?)
            .item(&PredefinedMenuItem::paste(handle, None)?)
            .item(&PredefinedMenuItem::select_all(handle, None)?)
            .build()?;
        let window_menu = SubmenuBuilder::new(handle, "Window")
            .item(&PredefinedMenuItem::minimize(handle, None)?)
            .build()?;
        MenuBuilder::new(handle)
            .item(&app_menu)
            .item(&edit_menu)
            .item(&view_menu)
            .item(&window_menu)
            .build()?
    };

    #[cfg(not(target_os = "macos"))]
    let menu = {
        let app_menu = SubmenuBuilder::new(handle, "Agent OS")
            .item(&PredefinedMenuItem::about(handle, None, None)?)
            .separator()
            .item(&quit)
            .build()?;
        MenuBuilder::new(handle).item(&app_menu).item(&view_menu).build()?
    };

    app.set_menu(menu)?;

    app.on_menu_event(|app, event| match event.id().as_ref() {
        RELOAD_MENU_ID => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.location.reload()");
            }
        }
        QUIT_MENU_ID => request_quit(app),
        SHOW_MENU_ID => show_main_window(app),
        _ => {}
    });
    Ok(())
}

// ---- the quit flow ---------------------------------------------------------
//
// Quitting can end the person's live sessions, so it asks first, through the page:
//   1. a quit request arrives (the Quit Agent OS item, closing the window on Windows/Linux, or
//      an exit request); the shell prevents the exit, shows the window and emits
//      agentos://quit-requested;
//   2. the page answers agentos://quit-shown as soon as it shows its question (or
//      agentos://quit-answer { quit: true } at once when no session is live);
//   3. if no quit-shown arrives within QUIT_SHOWN_WAIT, no page can ask, so the quit goes on;
//   4. after quit-shown the shell waits for agentos://quit-answer { quit } with no time limit.
//      { quit: false } keeps everything running; { quit: true } stops the server (stop_server:
//      the server ends every session and run, then exits) and exits the app.
//   A quit request while a question is open (or a quit is under way) asks nothing new: it only
//   shows, unminimizes and focuses the window again, so Cmd+Q brings a hidden question back.
// Events only: `listen` and `emit` are in core:default (capabilities/default.json). A custom
// `invoke` command would need an AppManifest, because the window's page is on 127.0.0.1.

/// What the shell does next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QuitStep {
    /// Nothing: nobody asked, or an answer or a clock arrived that no longer matters.
    Nothing,
    /// Ask the page (this is question number `round`) and start the QUIT_SHOWN_WAIT clock.
    Ask(u64),
    /// A question is already open or a quit is already under way: ask nothing new, only bring the
    /// window to the front (the person may have hidden or minimized it since).
    ShowAgain,
    /// Stop the server and exit.
    Quit,
}

/// Where the quit flow is. Pure, so the rules are unit tested.
#[derive(Debug, Default)]
struct QuitFlow {
    /// A question was sent to the page and not answered yet.
    asking: bool,
    /// The page said the question is on screen.
    shown: bool,
    /// The quit is under way: from here on the app is allowed to exit.
    quitting: bool,
    /// Counts the questions, so a 2 s clock left over from an answered question does nothing.
    round: u64,
}

impl QuitFlow {
    /// A quit request. `page_can_ask` is false when no page could show a question (the loading
    /// page is still up, or the server is gone): then the quit goes on at once. While a question
    /// is open or a quit is under way a request changes nothing but brings the window back.
    fn request(&mut self, page_can_ask: bool) -> QuitStep {
        if self.quitting || self.asking {
            return QuitStep::ShowAgain;
        }
        if !page_can_ask {
            self.quitting = true;
            return QuitStep::Quit;
        }
        self.asking = true;
        self.shown = false;
        self.round += 1;
        QuitStep::Ask(self.round)
    }

    /// agentos://quit-shown.
    fn shown(&mut self) {
        if self.asking {
            self.shown = true;
        }
    }

    /// agentos://quit-answer. An answer nobody asked for is ignored.
    fn answer(&mut self, quit: bool) -> QuitStep {
        if !self.asking {
            return QuitStep::Nothing;
        }
        self.asking = false;
        self.shown = false;
        if quit {
            self.quitting = true;
            QuitStep::Quit
        } else {
            QuitStep::Nothing
        }
    }

    /// QUIT_SHOWN_WAIT has passed since question `round` was sent.
    fn no_answer_in_time(&mut self, round: u64) -> QuitStep {
        if !self.asking || self.shown || self.round != round {
            return QuitStep::Nothing;
        }
        self.asking = false;
        self.quitting = true;
        QuitStep::Quit
    }

    /// The page started loading again (for example View > Reload). A question it was showing is
    /// gone, so the person must be able to quit again. A question it had not shown yet is left to
    /// the QUIT_SHOWN_WAIT clock, which then quits.
    fn page_gone(&mut self) {
        if self.asking && self.shown {
            self.asking = false;
            self.shown = false;
        }
    }

    fn exit_allowed(&self) -> bool {
        self.quitting
    }
}

/// `{ "quit": true }` or `{ "quit": false }`; anything else is not an answer.
fn quit_answer(payload: &str) -> Option<bool> {
    serde_json::from_str::<serde_json::Value>(payload).ok()?.get("quit")?.as_bool()
}

/// Only the server's own page (http://127.0.0.1:<port>/) has the quit question. The loading
/// page that shows while the server starts does not.
fn is_server_page(scheme: &str, host: Option<&str>) -> bool {
    scheme == "http" && host == Some("127.0.0.1")
}

fn page_can_ask(app: &AppHandle) -> bool {
    let server_running = app
        .state::<ServerState>()
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false);
    let on_server_page = app
        .get_webview_window("main")
        .and_then(|window| window.url().ok())
        .is_some_and(|url| is_server_page(url.scheme(), url.host_str()));
    server_running && on_server_page
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn request_quit(app: &AppHandle) {
    let can_ask = page_can_ask(app);
    let step = app
        .state::<QuitState>()
        .lock()
        .map(|mut flow| flow.request(can_ask))
        .unwrap_or(QuitStep::Quit);
    match step {
        QuitStep::Ask(round) => ask_page(app, round),
        QuitStep::Quit => finish_quit(app),
        // The question is already open (or the quit is under way): bring it to the front again.
        QuitStep::ShowAgain => show_main_window(app),
        QuitStep::Nothing => {}
    }
}

/// Shows the window (on macOS it may be hidden) and asks the page. If the page has not said
/// within QUIT_SHOWN_WAIT that its question is on screen, nobody can answer, so the quit goes on.
fn ask_page(app: &AppHandle, round: u64) {
    show_main_window(app);
    // If the event cannot be sent, no question appears, and the clock below quits.
    let _ = app.emit(QUIT_REQUESTED_EVENT, ());
    let handle = app.clone();
    thread::spawn(move || {
        thread::sleep(QUIT_SHOWN_WAIT);
        let step = handle
            .state::<QuitState>()
            .lock()
            .map(|mut flow| flow.no_answer_in_time(round))
            .unwrap_or(QuitStep::Nothing);
        if step == QuitStep::Quit {
            finish_quit(&handle);
        }
    });
}

/// Stops the server (it ends every session and run first) and then exits the app. Runs on its own
/// thread, so the window stays responsive while the server finishes.
fn finish_quit(app: &AppHandle) {
    let handle = app.clone();
    let server = Arc::clone(app.state::<ServerState>().inner());
    thread::spawn(move || {
        stop_server(&server);
        handle.exit(0);
    });
}

fn quit_allowed(app: &AppHandle) -> bool {
    app.state::<QuitState>()
        .lock()
        .map(|flow| flow.exit_allowed())
        .unwrap_or(true)
}

/// The page's two answers: "the question is on screen" and "quit or not".
fn listen_for_quit_answers(app: &tauri::App) {
    let handle = app.handle().clone();
    app.listen(QUIT_SHOWN_EVENT, move |_event| {
        if let Ok(mut flow) = handle.state::<QuitState>().lock() {
            flow.shown();
        }
    });
    let handle = app.handle().clone();
    app.listen(QUIT_ANSWER_EVENT, move |event| {
        let Some(quit) = quit_answer(event.payload()) else {
            return;
        };
        let step = handle
            .state::<QuitState>()
            .lock()
            .map(|mut flow| flow.answer(quit))
            .unwrap_or(QuitStep::Nothing);
        if step == QuitStep::Quit {
            finish_quit(&handle);
        }
    });
}

#[cfg(test)]
mod quit_flow_tests {
    use super::*;

    #[test]
    fn a_quit_with_a_page_that_can_ask_asks_first() {
        let mut flow = QuitFlow::default();
        assert_eq!(flow.request(true), QuitStep::Ask(1));
        assert!(!flow.exit_allowed(), "the app must not exit while the question is open");
    }

    #[test]
    fn with_no_page_to_ask_the_quit_goes_ahead_at_once() {
        let mut flow = QuitFlow::default();
        assert_eq!(flow.request(false), QuitStep::Quit);
        assert!(flow.exit_allowed());
    }

    #[test]
    fn a_second_quit_while_the_question_is_open_asks_nothing_new_and_does_not_quit() {
        let mut flow = QuitFlow::default();
        assert_eq!(flow.request(true), QuitStep::Ask(1));
        flow.shown();
        assert_eq!(flow.request(true), QuitStep::ShowAgain);
        assert_eq!(flow.request(false), QuitStep::ShowAgain);
        assert!(!flow.exit_allowed());
    }

    #[test]
    fn a_quit_request_while_asking_or_quitting_brings_the_window_back() {
        // Cmd+Q after the person hid or minimized the window while the question was open: the
        // question must come back to the front instead of nothing happening.
        let mut flow = QuitFlow::default();
        assert_eq!(flow.request(true), QuitStep::Ask(1));
        assert_eq!(flow.request(true), QuitStep::ShowAgain, "asked, the page has not shown the question yet");
        // ShowAgain changes nothing: the question is still number 1 and its 2 s clock still quits.
        assert_eq!(flow.no_answer_in_time(1), QuitStep::Quit);
        // A quit under way: the window comes back too, and the quit is not taken back.
        assert_eq!(flow.request(true), QuitStep::ShowAgain);
        assert_eq!(flow.request(false), QuitStep::ShowAgain);
        assert!(flow.exit_allowed());

        // After "keep running" the next request asks again: it is a question, not a ShowAgain.
        let mut flow = QuitFlow::default();
        assert_eq!(flow.request(true), QuitStep::Ask(1));
        flow.shown();
        assert_eq!(flow.request(true), QuitStep::ShowAgain);
        assert_eq!(flow.answer(false), QuitStep::Nothing);
        assert_eq!(flow.request(true), QuitStep::Ask(2));
    }

    #[test]
    fn no_quit_shown_within_the_wait_means_quit() {
        let mut flow = QuitFlow::default();
        let QuitStep::Ask(round) = flow.request(true) else {
            panic!("expected a question")
        };
        assert_eq!(flow.no_answer_in_time(round), QuitStep::Quit);
        assert!(flow.exit_allowed());
    }

    #[test]
    fn once_the_question_is_shown_the_shell_waits_for_the_answer() {
        let mut flow = QuitFlow::default();
        let QuitStep::Ask(round) = flow.request(true) else {
            panic!("expected a question")
        };
        flow.shown();
        assert_eq!(flow.no_answer_in_time(round), QuitStep::Nothing, "no time limit after quit-shown");
        assert!(!flow.exit_allowed());
        assert_eq!(flow.answer(true), QuitStep::Quit);
        assert!(flow.exit_allowed());
    }

    #[test]
    fn keep_running_cancels_and_a_later_quit_asks_again() {
        let mut flow = QuitFlow::default();
        assert_eq!(flow.request(true), QuitStep::Ask(1));
        flow.shown();
        assert_eq!(flow.answer(false), QuitStep::Nothing);
        assert!(!flow.exit_allowed());
        // The 2 s clock of the first question fires late: it must not quit.
        assert_eq!(flow.no_answer_in_time(1), QuitStep::Nothing);
        assert_eq!(flow.request(true), QuitStep::Ask(2));
    }

    #[test]
    fn an_answer_at_once_without_quit_shown_is_taken() {
        // The page answers { quit: true } straight away when no session is live.
        let mut flow = QuitFlow::default();
        assert_eq!(flow.request(true), QuitStep::Ask(1));
        assert_eq!(flow.answer(true), QuitStep::Quit);
    }

    #[test]
    fn an_answer_nobody_asked_for_is_ignored() {
        let mut flow = QuitFlow::default();
        assert_eq!(flow.answer(true), QuitStep::Nothing);
        assert!(!flow.exit_allowed());
        flow.shown();
        assert_eq!(flow.request(true), QuitStep::Ask(1), "a stray quit-shown does not block the next question");
    }

    #[test]
    fn a_reloaded_page_drops_a_question_it_was_showing() {
        let mut flow = QuitFlow::default();
        assert_eq!(flow.request(true), QuitStep::Ask(1));
        flow.shown();
        flow.page_gone();
        assert_eq!(flow.request(true), QuitStep::Ask(2), "the person can quit again after a reload");
    }

    #[test]
    fn a_page_that_reloads_before_showing_the_question_still_quits_on_time() {
        let mut flow = QuitFlow::default();
        assert_eq!(flow.request(true), QuitStep::Ask(1));
        flow.page_gone();
        assert_eq!(flow.no_answer_in_time(1), QuitStep::Quit);
    }

    #[test]
    fn once_quitting_nothing_else_happens() {
        let mut flow = QuitFlow::default();
        assert_eq!(flow.request(false), QuitStep::Quit);
        assert_eq!(flow.request(true), QuitStep::ShowAgain);
        assert_eq!(flow.answer(false), QuitStep::Nothing);
        assert_eq!(flow.no_answer_in_time(1), QuitStep::Nothing);
        assert!(flow.exit_allowed(), "a quit under way is never taken back");
    }

    #[test]
    fn the_answer_payload_must_be_a_true_or_false_quit() {
        assert_eq!(quit_answer(r#"{"quit":true}"#), Some(true));
        assert_eq!(quit_answer(r#"{"quit":false}"#), Some(false));
        for payload in ["null", "true", r#""quit""#, "{}", r#"{"quit":"true"}"#, r#"{"quit":1}"#, "not json"] {
            assert_eq!(quit_answer(payload), None, "{payload}");
        }
    }

    #[test]
    fn only_the_local_server_page_can_ask() {
        assert!(is_server_page("http", Some("127.0.0.1")));
        assert!(!is_server_page("tauri", Some("localhost")), "the loading page has no quit question");
        assert!(!is_server_page("http", Some("tauri.localhost")));
        assert!(!is_server_page("https", Some("127.0.0.1")));
        assert!(!is_server_page("http", None));
    }

    #[test]
    fn the_names_the_page_uses_are_ones_tauri_accepts() {
        for name in [QUIT_REQUESTED_EVENT, QUIT_SHOWN_EVENT, QUIT_ANSWER_EVENT] {
            assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || "-/:_".contains(c)), "{name}");
        }
        assert_eq!(QUIT_REQUESTED_EVENT, "agentos://quit-requested");
        assert_eq!(QUIT_SHOWN_EVENT, "agentos://quit-shown");
        assert_eq!(QUIT_ANSWER_EVENT, "agentos://quit-answer");
        assert_eq!(QUIT_MENU_ID, "agentos-quit");
        assert_eq!(SHOW_MENU_ID, "agentos-show");
    }

    #[test]
    fn the_quit_grace_outlasts_the_servers_own_hard_exit() {
        // server/runtime/shutdown.js exits by itself after 8 s at the latest.
        assert_eq!(QUIT_GRACE, Duration::from_secs(10));
        assert_eq!(QUIT_SHOWN_WAIT, Duration::from_secs(2));
        assert_eq!(SHUTDOWN_LINE, "AGENT_OS_SHUTDOWN\n");
    }
}

#[cfg(all(test, unix))]
mod stop_server_tests {
    use super::*;
    use std::process::{Command, Stdio};

    // A stand-in for the server: `sh`, with the same piped stdin the real server gets.
    fn server_running(script: &str) -> ServerState {
        let child = Command::new("sh")
            .args(["-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("sh starts");
        Arc::new(Mutex::new(Some(child)))
    }

    #[test]
    fn the_server_is_asked_through_its_stdin_and_ends_on_its_own() {
        let seen = env::temp_dir().join(format!("agentos-stdin-line-{}", std::process::id()));
        let script = format!("read line; printf '%s' \"$line\" > '{}'; exit 0", seen.display());
        let state = server_running(&script);
        let started = Instant::now();
        assert_eq!(stop_server_within(&state, Duration::from_secs(5)), Some(true));
        assert!(started.elapsed() < Duration::from_secs(4), "it ended on its own, long before the grace ran out");
        assert_eq!(std::fs::read_to_string(&seen).expect("the line was written"), "AGENT_OS_SHUTDOWN");
        let _ = std::fs::remove_file(&seen);
        assert!(state.lock().unwrap().is_none(), "the server is taken out of the state");
    }

    #[test]
    fn a_server_that_does_not_stop_is_forced_after_the_grace() {
        let state = server_running("exec sleep 30");
        let started = Instant::now();
        assert_eq!(stop_server_within(&state, Duration::from_millis(300)), Some(false));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn stopping_with_no_server_does_nothing() {
        let state: ServerState = Arc::new(Mutex::new(None));
        assert_eq!(stop_server_within(&state, Duration::from_millis(10)), None);
    }
}

#[cfg(test)]
mod alert_tests {
    use super::*;
    use std::io::Cursor;

    // What server/runtime/sessions/signals.js alertLine() prints for these two alerts.
    // test/release-config.test.js checks that the server still prints exactly these lines.
    const CLAUDE_LINE: &str = r#"AGENT_OS_ALERT:{"sessionId":"3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b","agent":"Claude Code","kind":"waiting","text":"Wants to use Bash"}"#;
    const CODEX_LINE: &str = r#"AGENT_OS_ALERT:{"sessionId":"3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b","agent":"Codex","kind":"approval","text":"Approval requested: run \"npm test\" in café"}"#;

    // An alert line for a Codex session with this kind and text.
    fn line(kind: &str, text: &str) -> String {
        format!(
            "{ALERT_LINE_PREFIX}{}",
            serde_json::json!({ "sessionId": "s-1", "agent": "Codex", "kind": kind, "text": text })
        )
    }

    #[test]
    fn an_alert_line_from_the_server_parses_into_a_note() {
        assert_eq!(ALERT_LINE_PREFIX, "AGENT_OS_ALERT:");
        assert_eq!(
            parse_alert_line(CLAUDE_LINE),
            Some(AlertNote {
                session_id: "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b".into(),
                agent: "Claude Code".into(),
                kind: "waiting".into(),
                text: "Wants to use Bash".into(),
            })
        );
        let codex = parse_alert_line(CODEX_LINE).expect("the Codex line is an alert");
        assert_eq!(codex.kind, "approval");
        assert_eq!(codex.text, "Approval requested: run \"npm test\" in café", "the JSON escapes are undone");
    }

    #[test]
    fn only_waiting_approval_and_limit_raise_a_notification() {
        for kind in ["waiting", "approval", "limit"] {
            assert_eq!(parse_alert_line(&line(kind, "t")).map(|note| note.kind), Some(kind.to_string()), "{kind}");
        }
        for kind in ["turn_done", "resolved", "", "WAITING", "waiting "] {
            assert_eq!(parse_alert_line(&line(kind, "t")), None, "{kind:?}");
        }
    }

    #[test]
    fn a_line_that_is_not_a_whole_alert_is_ignored() {
        let not_alerts = [
            "",
            "AGENT_OS_READY:4321",
            "Agent OS is running at http://127.0.0.1:4321/",
            "AGENT_OS_ALERT:",
            "AGENT_OS_ALERT:not json",
            r#"AGENT_OS_ALERT:["waiting"]"#,
            r#"AGENT_OS_ALERT:{"sessionId":"s-1","agent":"Codex","kind":"waiting"}"#,
            r#"AGENT_OS_ALERT:{"sessionId":"s-1","agent":"Codex","kind":"waiting","text":7}"#,
            r#"AGENT_OS_ALERT:{"sessionId":"","agent":"Codex","kind":"waiting","text":"t"}"#,
            r#"AGENT_OS_ALERT:{"sessionId":"s-1","agent":" ","kind":"waiting","text":"t"}"#,
            r#" AGENT_OS_ALERT:{"sessionId":"s-1","agent":"Codex","kind":"waiting","text":"t"}"#,
            r#"agent_os_alert:{"sessionId":"s-1","agent":"Codex","kind":"waiting","text":"t"}"#,
            r#"AGENT_OS_ALERT:{"sessionId":"s-1","agent":"Codex","kind":"waiting","text":"t"} and more"#,
        ];
        for text in not_alerts {
            assert_eq!(parse_alert_line(text), None, "{text:?}");
        }
        assert!(parse_alert_line(&line("waiting", "")).is_some(), "an empty text is still an alert: the title says enough");
    }

    #[test]
    fn the_alert_text_is_cut_to_200_characters_not_bytes() {
        let note = parse_alert_line(&line("waiting", &"é".repeat(250))).expect("an alert");
        assert_eq!(note.text, "é".repeat(200), "200 letters, none of them split");
        let exact = "a".repeat(200);
        assert_eq!(parse_alert_line(&line("limit", &exact)).expect("an alert").text, exact);
    }

    #[test]
    fn the_title_says_which_agent_and_what_happened() {
        assert_eq!(alert_title("waiting", "Claude Code").as_deref(), Some("Claude Code is waiting for you"));
        assert_eq!(alert_title("approval", "OpenClaw").as_deref(), Some("OpenClaw is waiting for you"));
        assert_eq!(alert_title("limit", "Codex").as_deref(), Some("Codex's plan ran out"));
        assert_eq!(alert_title("turn_done", "Codex"), None);
        assert_eq!(alert_title("resolved", "Codex"), None);
    }

    #[test]
    fn a_notification_shows_only_when_the_window_is_hidden_or_not_focused() {
        assert!(!should_notify(true, true), "the person is looking at Agent OS: the page shows the alert");
        assert!(should_notify(true, false), "another app is in front");
        assert!(should_notify(false, false), "the window is hidden (macOS: closed with the red button) or minimized");
        assert!(should_notify(false, true));
    }

    #[test]
    fn a_click_on_the_notification_brings_the_window_back() {
        assert_eq!(NOTIFICATION_TAP, "tap");
        assert!(notification_click_shows_window("tap"));
        for other in ["", "dismiss", "Tap", "snooze"] {
            assert!(!notification_click_shows_window(other), "{other:?}");
        }
    }

    #[test]
    fn a_line_that_is_not_utf8_does_not_stop_the_reader() {
        let alert = line("limit", "Codex's plan limit was reached.");
        let mut input = b"first\n\xff\xfe not text \xc3\n".to_vec();
        input.extend_from_slice(alert.as_bytes());
        input.extend_from_slice(b"\nlast");
        // What the old reader (BufRead::lines) did: it stopped at the first line that is not
        // UTF-8, and nothing drained the pipe after that.
        let old: Vec<String> = Cursor::new(input.as_slice()).lines().map_while(Result::ok).collect();
        assert_eq!(old, ["first"]);
        let mut lines = Vec::new();
        read_lines_lossy(Cursor::new(input.as_slice()), |line| lines.push(line.to_string()));
        assert_eq!(lines, ["first", "\u{fffd}\u{fffd} not text \u{fffd}", alert.as_str(), "last"]);
        assert_eq!(parse_alert_line(&lines[2]).map(|note| note.kind), Some("limit".to_string()));
    }

    #[test]
    fn a_title_never_holds_a_very_long_or_odd_agent_name() {
        let with_agent = |agent: &str| {
            format!(
                "{ALERT_LINE_PREFIX}{}",
                serde_json::json!({ "sessionId": "s-1", "agent": agent, "kind": "waiting", "text": "t" })
            )
        };
        let long = parse_alert_line(&with_agent(&"A".repeat(100))).expect("an alert");
        assert_eq!(long.agent, "A".repeat(40), "40 characters at most");
        assert_eq!(alert_title(&long.kind, &long.agent).as_deref(), Some(format!("{} is waiting for you", "A".repeat(40)).as_str()));
        let letters = parse_alert_line(&with_agent(&"é".repeat(100))).expect("an alert");
        assert_eq!(letters.agent, "é".repeat(40), "characters, not bytes: none is split");
        let odd = parse_alert_line(&with_agent("Co\u{7}de\n\u{1b}[31m X")).expect("an alert");
        assert_eq!(odd.agent, "Code[31m X", "control characters are removed");
        assert_eq!(parse_alert_line(&with_agent("Claude Code")).expect("an alert").agent, "Claude Code");
        assert_eq!(parse_alert_line(&with_agent("\u{7}\n \u{1b}")), None, "a name that is only control characters and spaces is no name");
    }

    #[test]
    fn a_line_over_the_size_limit_is_not_an_alert() {
        let big = format!("{ALERT_LINE_PREFIX}{}", serde_json::json!({ "sessionId": "s-1", "agent": "Codex", "kind": "waiting", "text": "t", "pad": "x".repeat(ALERT_LINE_MAX_BYTES) }));
        assert!(big.len() > ALERT_LINE_MAX_BYTES);
        assert_eq!(parse_alert_line(&big), None);
        // Deeply nested and very long: refused at once, never parsed.
        assert_eq!(parse_alert_line(&format!("{ALERT_LINE_PREFIX}{}", "[".repeat(100_000))), None);
        // A real alert with the longest text the server prints (200 characters, all escaped) fits.
        let worst = format!("{ALERT_LINE_PREFIX}{}", serde_json::json!({ "sessionId": "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b", "agent": "Claude Code", "kind": "approval", "text": "\u{1}".repeat(200) }));
        assert!(worst.len() < ALERT_LINE_MAX_BYTES, "{} bytes", worst.len());
        assert!(parse_alert_line(&worst).is_some());
    }

    #[test]
    fn a_very_long_line_is_cut_short_and_the_next_line_still_comes() {
        let mut input = vec![b'x'; 2 * LINE_MAX_BYTES + 5];
        input.extend_from_slice(b"\nnext\r\nlast");
        let mut lines = Vec::new();
        read_lines_lossy(Cursor::new(input.as_slice()), |line| lines.push(line.to_string()));
        assert_eq!(lines.len(), 3, "the long line, the next one and the last one");
        assert_eq!(lines[0].len(), LINE_MAX_BYTES, "only the first LINE_MAX_BYTES bytes are kept");
        assert!(lines[0].bytes().all(|byte| byte == b'x'));
        assert_eq!(&lines[1..], ["next", "last"]);
    }

    #[test]
    fn a_line_right_at_the_size_limit_and_one_without_an_ending_are_handled() {
        let alert = line("waiting", "Wants to use Bash");
        // LINE_MAX_BYTES - 1 letters and the ending: the whole line, nothing dropped.
        let mut exact = vec![b'y'; LINE_MAX_BYTES - 1];
        exact.push(b'\n');
        exact.extend_from_slice(alert.as_bytes());
        exact.push(b'\n');
        let mut lines = Vec::new();
        read_lines_lossy(Cursor::new(exact.as_slice()), |line| lines.push(line.to_string()));
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].len(), LINE_MAX_BYTES - 1);
        assert_eq!(lines[1], alert);
        // LINE_MAX_BYTES letters and the ending: the letters are kept, the ending is dropped, and the next line is whole.
        let mut full = vec![b'z'; LINE_MAX_BYTES];
        full.push(b'\n');
        full.extend_from_slice(alert.as_bytes());
        let mut lines = Vec::new();
        read_lines_lossy(Cursor::new(full.as_slice()), |line| lines.push(line.to_string()));
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].len(), LINE_MAX_BYTES);
        assert_eq!(lines[1], alert);
        // A long line that ends with the input, no ending at all: cut, and the reader ends.
        let ending = vec![b'q'; LINE_MAX_BYTES + 100];
        let mut lines = Vec::new();
        read_lines_lossy(Cursor::new(ending.as_slice()), |line| lines.push(line.to_string()));
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].len(), LINE_MAX_BYTES);
    }

    #[test]
    fn bytes_that_are_not_utf8_inside_an_alert_line_still_make_an_alert() {
        let mut input = b"AGENT_OS_ALERT:{\"sessionId\":\"s-1\",\"agent\":\"Codex\",\"kind\":\"waiting\",\"text\":\"a".to_vec();
        input.extend_from_slice(b"\xff\xc3");
        input.extend_from_slice(b"b\"}\nnext\n");
        let mut lines = Vec::new();
        read_lines_lossy(Cursor::new(input.as_slice()), |line| lines.push(line.to_string()));
        assert_eq!(lines.len(), 2, "the bad bytes do not end the reader");
        assert_eq!(lines[1], "next");
        let note = parse_alert_line(&lines[0]).expect("an alert, with the bad bytes replaced");
        assert_eq!(note.text, "a\u{fffd}\u{fffd}b");
        assert_eq!(note.agent, "Codex");
    }

    #[test]
    fn line_endings_go_and_the_ready_line_still_parses() {
        let input: &[u8] = b"AGENT_OS_READY:4321\r\nplain\n\nno ending\r";
        let mut lines = Vec::new();
        read_lines_lossy(Cursor::new(input), |line| lines.push(line.to_string()));
        assert_eq!(lines, ["AGENT_OS_READY:4321", "plain", "", "no ending\r"]);
        let old: Vec<String> = Cursor::new(input).lines().map_while(Result::ok).collect();
        assert_eq!(lines, old, "for text that is UTF-8, the same lines BufRead::lines() gave");
        assert_eq!(parse_ready_line(&lines[0]), Some(4321));
    }
}
