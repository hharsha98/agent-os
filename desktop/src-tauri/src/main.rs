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
//!     |-- this Rust shell (window, menu, quit handling)
//!     |      spawns -->  resources/node/bin/node resources/server/server.mjs
//!     |                    PORT=0  AGENT_OS_TOKEN=<random>  AGENT_OS_STATIC_DIR=...
//!     |      reads  <--  stdout "AGENT_OS_READY:<port>"
//!     |      opens  -->  http://127.0.0.1:<port>/?launch=<token>&desktop=1
//! ```
//!
//! The most important job here is cleanup: when the app quits, by any route,
//! the server (and the agent runs it started) must be stopped.

use std::collections::VecDeque;
use std::env;
use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Manager, WebviewWindow};
use url::Url;

/// What the server prints on stdout once it is listening.
const READY_LINE_PREFIX: &str = "AGENT_OS_READY:";
/// How long to wait for that line before showing an error.
const READY_TIMEOUT: Duration = Duration::from_secs(20);
/// How many trailing stderr lines the error page can show.
const STDERR_TAIL_LINES: usize = 20;
/// How long a quitting app waits for the server to stop its agent runs
/// cleanly before force-killing it (unix; Windows kills the tree at once).
#[cfg(unix)]
const QUIT_GRACE: Duration = Duration::from_secs(5);

/// The running server, shared between the window, the exit handler and the
/// signal thread. `None` once it has been shut down.
type ServerState = Arc<Mutex<Option<Child>>>;

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
        // PORT=0: let the OS pick a free port, so two copies never collide.
        .env("PORT", "0")
        .env("AGENT_OS_TOKEN", token)
        .env("AGENT_OS_STATIC_DIR", &launch.static_dir)
        .env("AGENT_OS_PACKAGED", "1")
        .env("PATH", server_path_env())
        .stdin(Stdio::null())
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

/// Reads the server's output for one startup attempt. Both pipes are drained
/// for the server's whole life: if nobody read them, a chatty server would
/// eventually block on a full pipe (or hit a broken one) and hang or crash.
/// stderr is kept as a short tail for the error page, with the login token
/// scrubbed out in case anything ever echoes it.
fn watch_server(
    stdout: ChildStdout,
    stderr: ChildStderr,
    token: String,
    tx: mpsc::Sender<ServerStartup>,
) {
    let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    {
        let tail = Arc::clone(&tail);
        let token = token.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut tail = tail.lock().unwrap();
                if tail.len() >= STDERR_TAIL_LINES {
                    tail.pop_front();
                }
                tail.push_back(line.replace(&token, "[hidden]"));
            }
        });
    }

    let mut reported = false;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if !reported {
            if let Some(port) = parse_ready_line(&line) {
                reported = true;
                let _ = tx.send(ServerStartup::Ready(port));
            }
        }
    }

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

/// Stops the server. Called from the window-close handler, from the app-exit
/// event and (unix) from the signal thread, because each covers a different
/// way of quitting. Safe to call more than once: `take()` makes later calls
/// do nothing.
///
/// Unix: SIGTERM first. The server reacts by stopping every agent run it
/// started (whole process trees) and then exits; that can take a few seconds,
/// so we wait up to QUIT_GRACE before forcing it. Windows has no SIGTERM, so
/// `taskkill /T /F` ends the whole tree at once.
fn kill_server(state: &ServerState) {
    let Some(mut child) = state.lock().ok().and_then(|mut guard| guard.take()) else {
        return;
    };

    #[cfg(unix)]
    {
        unsafe {
            libc::kill(child.id() as i32, libc::SIGTERM);
        }
        let deadline = Instant::now() + QUIT_GRACE;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return, // exited cleanly: the normal case
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
                _ => break,
            }
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
}

/// A plain `kill <pid>` on this app skips Tauri's own quit path entirely, so
/// without this the server would be left running. signal-hook delivers the
/// signal to an ordinary thread (not real signal context), where taking a
/// mutex is safe.
#[cfg(unix)]
fn install_signal_handler(state: ServerState) {
    use signal_hook::consts::{SIGINT, SIGTERM};
    use signal_hook::iterator::Signals;

    let Ok(mut signals) = Signals::new([SIGTERM, SIGINT]) else {
        return; // best effort: normal quit paths still work
    };
    thread::spawn(move || {
        if signals.forever().next().is_some() {
            kill_server(&state);
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
        .plugin(tauri_plugin_process::init());
    if updater_configured {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .manage(server_state)
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("the \"main\" window is declared in tauri.conf.json");

            start_server(app, &window);
            build_menu(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                kill_server(&window.app_handle().state::<ServerState>());
            }
        })
        .build(context)
        .expect("error while building the Agent OS desktop app")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                kill_server(&app_handle.state::<ServerState>());
            }
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
    thread::spawn(move || watch_server(stdout, stderr, watch_token, tx));

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

/// App menu: About / Hide / Quit, Edit (so copy and paste work in text
/// fields), View > Reload, Window > Minimize.
fn build_menu(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle();

    let app_menu = SubmenuBuilder::new(handle, "Agent OS")
        .item(&PredefinedMenuItem::about(handle, None, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(handle, None)?)
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

    let reload = MenuItemBuilder::with_id("reload", "Reload")
        .accelerator("CmdOrCtrl+R")
        .build(handle)?;
    let view_menu = SubmenuBuilder::new(handle, "View").item(&reload).build()?;

    let window_menu = SubmenuBuilder::new(handle, "Window")
        .item(&PredefinedMenuItem::minimize(handle, None)?)
        .build()?;

    let menu = MenuBuilder::new(handle)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()?;
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        if event.id().as_ref() == "reload" {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.location.reload()");
            }
        }
    });
    Ok(())
}
