<h1 align="center">Agent OS</h1>

<p align="center">
  <strong>Agent OS is a desktop control room for AI agents: install, configure, launch, watch and stop Hermes Agent, OpenClaw, Claude Code, Codex and Cursor from one window, safely by default.</strong>
</p>

<p align="center">
  <a href="https://github.com/hharsha98/agent-os/releases/latest"><img src="https://img.shields.io/badge/Download-latest_release-111318?style=for-the-badge" alt="Download the latest release" /></a>
  <a href="#run-from-source"><img src="https://img.shields.io/badge/Run_from-source-ff7a2f?style=for-the-badge" alt="Run from source" /></a>
  <img src="https://img.shields.io/badge/license-MIT-8f96a3?style=for-the-badge" alt="MIT license" />
</p>

<p align="center"><em>Version 0.4. Unsigned builds. Hand-tested on macOS (Apple silicon) only.</em></p>

![Agent OS Home page in a dark theme, version v0.4.0. The headline says All five are installed. Nothing is running right now. A ring diagram and a table list Hermes Agent, OpenClaw, Claude Code, Codex CLI and Cursor Agent with their brains, such as OpenRouter for Hermes and the ChatGPT plan for OpenClaw, each marked Ready. A New session button is at the top right, and the top bar shows Level 0 Look only and a Hold to stop all button.](docs/screenshots/v2/home.png)

<sub>Home, recorded on the author's own Mac with Safety on "Look only", so nothing is running.</sub>

---

## Download

Get the installer for your computer from the [latest release](https://github.com/hharsha98/agent-os/releases/latest). The first public version, v0.3.0, came out on 1 October 2026.

Which file is yours:

| Your computer | Download |
| --- | --- |
| Mac with an Apple chip (M1, M2, M3, M4...) | the `.dmg` with `aarch64` in its name |
| Mac with an Intel chip | the `.dmg` with `x64` in its name |
| Windows 10 or 11 | the `setup.exe` |
| Linux (Debian, Ubuntu and friends) | the `.deb` |
| Linux (anything else) | the `.AppImage` |

Not sure which Mac you have? Apple menu > About This Mac. "Chip" means Apple silicon. "Processor" means Intel.

### First launch (the builds are unsigned)

I have not paid for Apple or Microsoft developer certificates, so your computer will warn you the first time. The warning is expected.

- **macOS:** right-click the app, choose **Open**, then click **Open** again. On macOS 15 or newer it may still refuse. Then open **System Settings > Privacy & Security**, scroll down, and click **Open Anyway**.
- **Windows:** when SmartScreen says "Windows protected your PC", click **More info**, then **Run anyway**.
- **Linux:** an AppImage needs permission to run: `chmod +x Agent-OS_*.AppImage`, then double-click it or run it from a terminal.

The first time it opens, Agent OS starts a small private server on your computer. You do not need to install Node or anything else first. The **Setup Assistant** checks your computer and offers to install the five agents. **Nothing is installed until you click for it.**

---

## What it does

Agent OS has a sidebar with eight main pages: Home, Sessions, Agents, Runs, Team Room, Workspace, Setup and Safety. A collapsed **Labs** group holds older, experimental pages, including the dry-run Chat. The pages below are the ones built for the desktop app.

Version 0.4 has a new look: dark only, a cobalt-blue accent, a new logo (a ring with five dots), and fonts that ship inside the app so it looks the same offline. On a window about 1,366 px wide or less, the menu shrinks to icons. Press ⌘K (Ctrl+K on Windows and Linux) to search pages and actions.

### Sessions

A session is an agent's own terminal program running inside Agent OS. It is your installed copy of Claude Code, Codex, Cursor, Hermes or OpenClaw, so your keys and slash commands work the way they do in Terminal. Agent OS starts each program the way a normal terminal would, with your own sign-in and settings (if you picked an OpenRouter or Local brain for Claude Code or Codex in Agent OS, the session uses that brain). It never sets your home folder or the agents' config folders.

![Agent OS Sessions page with one live Hermes Agent session in a folder named notes-app. The terminal shows Hermes's own question, Help improve Hermes?, which explains its shared usage counters and offers three choices: Collect and send to Nous, Collect locally only, and No thanks, which is highlighted. Nothing was answered or typed. The side panel shows the session as Live with a Stop session button, the footer reads v0.4.0, and the top bar shows Level 1 Run agents.](docs/screenshots/v2/sessions.png)

<sub>Sessions, on the author's Mac: a live Hermes Agent session in a throwaway demo folder, stopped right after this shot. Everything inside the terminal is Hermes's own output: its question about sharing usage counters, with "No thanks" already highlighted. Nothing was typed or answered. The tab and the side panel are Agent OS.</sub>

- **New session:** pick an agent and a folder. The folder can be any folder inside your home folder, but not the home folder itself and not Agent OS's own data folder. The desktop app has a folder picker, you can pick a recent folder, and in a browser tab you type the full path. Sessions need Safety level 1 ("Run agents"), and at most 8 can be open at once.
- **Tabs:** one tab per session, named by its agent and folder. An ended session's tab says so, and you can dismiss it. The side panel shows the state (starting, live or ended), the brain, how long the session has run, whether it is recorded, and a Stop button.
- **Closing the window does not stop a session on macOS.** The window hides, the sessions keep running, and the Dock icon brings it back. On Windows and Linux there is no tray icon, so closing the window quits, after asking if sessions are open.
- **Quitting asks first** when sessions are live (⌘Q or the Quit menu item on a Mac). It names them and lets you cancel. An ended session keeps its tab and its recording, and you can resume it.
- **Recordings:** every session is recorded on your computer, in a folder that only you can read. A recording holds what the terminal showed, not what you typed, but text that appears on screen after you type it is part of the output. Recordings are listed in Runs, under "Session recordings". Each one keeps at most about 50 MB, and all recordings together stay under 1 GB (the oldest ended ones are removed first).
- **Resume conversation** brings an ended session back in the same tab.
- **Stop** ends the agent's program and the commands it started. **Hold to stop all** (the red button in the top bar, held for about a second) stops every session and every run.
- **Nothing answers for you.** Agent OS only passes on what you type, plus the small replies a terminal gives to its program. It never types an answer into an agent.

What each agent does in a session:

| Agent | How the session starts | What Resume brings back |
| --- | --- | --- |
| Claude Code | `claude` with a session id Agent OS picks | that exact conversation (if something was sent in it) |
| Codex | `codex` in your folder | the most recent Codex conversation in that folder |
| Cursor | `agent` in your folder, on a new chat | that chat (if Agent OS could not get a chat id at the start, Cursor's own chat picker opens) |
| Hermes Agent | `hermes` in your folder, with the interface you set up | the most recent Hermes conversation in that folder |
| OpenClaw | `openclaw tui` with a session name Agent OS picks | that session. OpenClaw starts in your home folder (see Limits) |

For Codex and Hermes, Agent OS cannot tell which conversation is "yours". So Resume warns that it may bring back one you started outside Agent OS, and it is switched off when two ended sessions share the folder or another session of that agent is open there.

Agent OS runs each agent's terminal program. Features that only exist in a vendor's desktop app or editor are not part of it.

### Your plan

For OpenClaw, the **Your plan** card (on its Agents page, and in Setup's "AI brain" step) lets it use a plan you already pay for, instead of an API key.

![Agent OS Agents page for OpenClaw, scrolled to the Your plan card. It shows a warning that the bot can read files and run actions, an unticked acknowledgement box, and two model lists, Claude plan and ChatGPT plan, with an Apply button that is not pressed. The Claude Fable models note that they use usage credits, and one Claude model is marked as not available on the plan in this OpenClaw yet.](docs/screenshots/v2/agents-plan.png)

<sub>Agents > OpenClaw, scrolled to the "Your plan" card, on the author's Mac. Nothing in it was pressed.</sub>

- **Claude plan:** OpenClaw runs your own signed-in Claude Code program, so it shares your Claude plan limits. It needs Claude Code installed and signed in with Claude Code's own sign-in. If Claude Code uses an API key or a cloud account, the card says OpenClaw would bill that instead, and offers no Apply.
- **ChatGPT plan:** "Sign in with ChatGPT" opens OpenClaw's own sign-in inside the card, in a small terminal. You approve in your browser. It needs OpenClaw 2026.9.7 or newer, and the card says so if yours is older.
- **Model list:** the models your account offers, read from OpenClaw. If the list cannot be read, the card shows a short list marked as possibly out of date. Fable models say that they use usage credits.
- **Before Apply** you tick OpenClaw's own risk notice. Apply then sets the model and switches OpenClaw to "ask before running commands" if it was not already. Then it asks the agent to say hello, to prove it works. At Look only the hello check is skipped, and the card says so.
- **Hermes:** the Agents page for Hermes has "Choose in Hermes" and "Add a sign-in in Hermes". They open Hermes's own model picker (`hermes model`) or sign-in helper (`hermes auth`) in a Terminal.app window. On Windows and Linux, Agent OS shows the command to copy instead. Agent OS then reads what Hermes saved. Nothing you type there passes through Agent OS.

On the rules behind this. Agent OS only sets up routes that, as far as I can tell from the vendors' own published terms (read on 15 October 2026), are allowed for personal use: your own subscription, on your own computer, signed in through the vendor's own sign-in. Agent OS never reads, stores or passes on your sign-in token. It asks the agents' own commands instead, and the sign-in terminal keeps nothing (it is never recorded). Anthropic has changed its rules on this several times this year and can enforce them without notice, so the card says that too. Hermes's picker may offer routes that Anthropic or OpenAI do not allow for apps like Hermes, so two short warnings sit next to its button. I am not a lawyer: check the vendors' current terms. If Agent OS is ever hosted or charged for, these routes need checking again.

### Agents

Hermes Agent, OpenClaw, Claude Code, Codex and Cursor each get a page. It shows the detected version, whether the agent is ready, which brain it uses, its safeguards and, for Hermes and OpenClaw, its background service, which you can start, stop and restart. Runs start from the Runs page, and terminals from Sessions.

### Runs

A run is one task an agent does on its own, without a terminal. Every run is recorded: its output as it streams in, how long it ran, and a **Stop** button. The command and working folder are in a "Flight plan" you can open. The page has three bays: Active, Held (paused by a plan limit, where Claude Code and Codex runs can keep going on OpenRouter) and Landed.

The second tab, **Session recordings**, lists every recorded session, with Resume conversation.

![Agent OS Runs page on the Session recordings tab. It lists one saved recording, Hermes in ~/aos-demo/notes-app, 33 seconds long and recorded a minute ago, with a Resume conversation button and the note Replay arrives in a later update. The top bar shows Level 1 Run agents.](docs/screenshots/v2/runs-recordings.png)

<sub>Runs, on the Session recordings tab, on the author's Mac. It lists the recording of the demo session above.</sub>

### Team Room

Hermes Agent and OpenClaw talk a task through, one message at a time, while you read along. You set the limits: 2 to 12 turns, 1 to 30 minutes, and an optional cost cap. Hermes speaks first. Each turn is an ordinary run, so it also shows on the Runs page and can be stopped.

- Agent OS asks both agents to only talk. It passes each message along.
- If both agents agree on a file (`.md`, `.txt` or `.html`), nothing is saved until you press **Approve**. The room pauses while it waits, and its time limit stops running. A saved file goes into a folder for that room inside the Workspace, and Undo puts it back.
- A room needs Safety level 1. At Look only a room does not start, and a room already going stops before its next turn.
- The cost cap only counts turns that report a cost. Hermes may report none.

Team Room is in the main menu and is not marked as experimental in the app. The automated tests run whole rooms with test agents. I have not hand-tested a full room with the real Hermes and OpenClaw for this release, so treat it as less proven than Sessions.

### Setup

The Setup Assistant walks through six steps: check your computer, plan, install, pick an AI model ("brain"), sign in, ready.

- It only uses the **official installers** of the five agents (Codex is an npm package, installed into your own folder). It shows what each one will change before you click.
- An agent you already have is **kept** by default, not reinstalled.
- For the brain of Hermes and OpenClaw you can connect OpenRouter in your browser (free models to start), use a local Ollama model, or, for OpenClaw, use your plan (see above). Agent OS does not install Ollama. If you have it, Agent OS can ask it to download a model, after asking you.
- By default Agent OS does not keep your OpenRouter key. It checks the key with OpenRouter and hands it to Hermes's or OpenClaw's own setup commands, which store it in their own config. One opt-in tick, "Remember for coding agents", saves the key in your Mac's Keychain (a private file on other systems) so Claude Code and Codex can run on OpenRouter later. You can forget it again.
- Signing in to Claude Code, Codex and Cursor uses each agent's own login. Agent OS never sees your password and does not open the agents' credential files.
- It will switch OpenClaw to "ask before running commands", after you confirm.

![Agent OS Setup page at the AI brain step with three cards. OpenRouter (Recommended, Free to start) has a Connect OpenRouter button. Local (Ollama) lists installed models marked as fitting or too big for this 24 GB computer. Your plan, at the bottom, shows OpenClaw's security notice, an unticked box and the first models of the Claude plan and ChatGPT plan lists. The step list on the left shows Check, Plan and Install done and AI brain current.](docs/screenshots/v2/setup-brain.png)

<sub>Setup, at the "AI brain" step, on the author's Mac, where the earlier steps were already done. It is a taller window than the other screenshots, so that all three cards fit.</sub>

### Safety

Three levels. A fresh install starts at level 0. [More on this below](#safety-by-default).

![Agent OS Safety page with three levels side by side: Look only (current), Run agents and Machine control. A panel below explains that at Level 0 agents can see installed agents and past runs, that no new agent run, session or Team Room can start, and that a run or session already going keeps going until it ends or you stop it. The Safeguards table starts at the bottom.](docs/screenshots/v2/safety.png)

<sub>Safety, on the author's Mac.</sub>

### What each agent runs with

This is what Agent OS passes when you start a **run** from the Runs page (checked in `server/runtime/agents/`). A session is different: it is the agent's own terminal, and the agent asks its own permissions inside your folder, as it does in Terminal.

| Agent | How a run starts |
| --- | --- |
| Claude Code | print mode with `--permission-mode dontAsk` (`acceptEdits` only if you tick "allow edits") |
| Codex | `codex exec` with a read-only sandbox (`workspace-write` only if you tick "allow edits") |
| Cursor | proposes changes only. Agent OS never lets it apply them: open Cursor to do that |
| Hermes Agent | runs through Hermes's own approval setting. Agent OS shows whether approvals are on |
| OpenClaw | runs through OpenClaw's own settings. Agent OS can switch it to "ask before running commands" |

---

## Safety by default

There are three levels. A fresh install is at level 0, "Look only". If you turn on level 1 it is remembered between launches (it is saved in a local config file), until you switch back. Level 2 is never remembered.

| Level | Name | What it means |
| --- | --- | --- |
| 0 | Look only | Agents are detected and past runs are shown. **No new agent run, session or Team Room starts**, and a running room stops before its next turn. A run or session that is already going keeps going until it ends or you stop it. Setup's own install, sign-in and config steps still run when you press them. |
| 1 | Run agents | You can start agents you choose. A run starts in a folder inside the Workspace (OpenClaw's Gateway uses its own folder). A session starts in a folder you pick inside your home folder, where the agent asks its own permissions. Every run shows its command and folder on the Runs page, and every session is recorded. |
| 2 | Machine control | Voice, typing, clicking, screen reading and shell commands. **macOS only.** |

Level 2 is hard to turn on on purpose:

- You must be at level 1 first, then type the exact phrase `ENABLE MACHINE CONTROL`.
- It lives only in the server's memory. It turns itself off after 30 minutes, when Agent OS restarts, or when you go back to level 0.
- Each shell command still asks you first.
- The **Machine Control** page in Labs is status only. It has no Run command button.

What Agent OS does not do:

- **No "skip permissions" flags.** Flags like `--dangerously-skip-permissions`, `--yolo` and `--force` are rejected when you configure an agent and filtered out again before a command is launched, for runs and for sessions. A session only gets small extra options: a session id or name, its folder, the agent's own resume option when you resume, Codex's notification settings and, for Claude Code or Codex on an OpenRouter or Local brain, the settings for that brain.
- **Runs start in the sandbox folder.** Agent OS refuses any other folder for a run. OpenClaw is the exception: when its Gateway is running, a run works in OpenClaw's own folder, as the Safety page says. This is a working folder, not an operating-system jail: what an agent can touch is still decided by that agent's own permissions.
- **Sessions are not sandboxed.** A session can use any folder inside your home folder that you pick, and the agent asks its own permissions there. Agent OS refuses your home folder itself and its own data folder.
- **Nothing answers for you.** Agent OS never types an answer into an agent's question.
- **Nothing installs without a click.** Setup shows the plan first.
- **It does not keep your API keys by default.** The one exception is the opt-in "Remember for coding agents" tick. See Setup above.
- **The server is local only.** It listens on `127.0.0.1`, checks the `Host` and `Origin` headers, and needs a login token. The token is new on every launch. The desktop app logs you in for you. From source, `npm start` prints a one-time login link. The terminals use a WebSocket (a live two-way connection) with its own checks of the host, origin and login cookie.
- **Hold to stop all** stops every session and every run, Team Room turns included. It does not stop the Hermes background service, the OpenClaw Gateway or Agent OS's own setup jobs. Each service has its own Stop on Agents.

This is a safety design, not a guarantee. It has not had an outside security review. An agent you start at level 1 is a real program that can do real things inside its own permissions.

---

## Tested on

| Platform | State |
| --- | --- |
| macOS (Apple silicon, arm64) | Hand-tested. The v0.3.0 release installer was installed and launched on the author's Mac. For 0.4, an earlier desktop build of the 0.4.0 work (made before the plan-brains changes) ran on the same Mac with a live Claude Code session open (see below). The v0.4.0 installer itself is built by the release workflow and was not installed by hand before publishing. |
| macOS (Intel) | Built by the release workflow. **Not hand-tested.** |
| Windows | Built by the release workflow. **Not hand-tested.** |
| Linux | Built by the release workflow. **Not hand-tested.** |

- **Unit tests:** 1,454 tests (`npm test`). On the author's Mac: 1,450 pass, 4 skipped, 0 fail. They use fake agents, so no test starts a real one.
- **Sessions, by hand (Apple silicon Mac):** each of the five real agents was opened and stopped in a session. Resume was tried with Codex, Hermes and Cursor. Claude Code's Resume was only tried on a session where nothing had been sent, which correctly says there is nothing to resume. Resuming a real Claude Code conversation is covered by the automated tests with a fake agent, not by hand.
- **The desktop app, by hand** (an earlier build, made before the plan-brains changes): with a live Claude Code session open (nothing was sent to it), ⌘Q asked first and named the session. "Keep running" kept both. Quit ended the session and the app. After reopening, the tab said the session ended when Agent OS quit, and Resume was offered. Closing the window left the session running, and the Dock icon brought the window back.
- **Plan brains, by hand:** on 16 October 2026, with OpenClaw 2026.10.4, one Claude plan model and one ChatGPT plan model were applied from the card, and each passed the hello check. The first ChatGPT attempt stopped at the sign-in check (the internet had dropped, and the check was stricter than it needed to be). The next attempt passed, and the check was made less strict afterwards. The ChatGPT sign-in worked inside the card, and "Choose in Hermes" opened Hermes's picker in Terminal.app.
- **CI** (`.github/workflows/ci.yml`) runs the tests on Ubuntu, macOS and Windows with Node 24, a smoke test on Ubuntu, and a build of the desktop shell on all three.
- **Release workflow** (`.github/workflows/release.yml`) builds the installers for the four rows above. It built v0.3.0.
- **Screenshots** in this file are real: the author's Mac, the real installed agents, a throwaway Agent OS data folder, and nothing typed into any agent.

---

## Run from source

For developers. You need **Node 24** (what CI and the desktop app use; `package.json` allows 18 or newer, but only 24 is tested).

```bash
git clone https://github.com/hharsha98/agent-os.git
cd agent-os
npm install
npm run build
npm start
```

`npm start` prints a line like `Agent OS is running. Open: http://127.0.0.1:8090/?launch=...`. Open that link. It signs you in for this run of the server. A plain `http://127.0.0.1:8090` without the token will be refused for the API.

```bash
npm test                  # unit tests (use `env -u HERMES_HOME npm test` if you have HERMES_HOME set)
npm run dev               # hot reload: UI on 5173, API on 8090
npm run desktop:build     # build the desktop app (needs Rust, see below)
```

The desktop build needs [Rust](https://rustup.rs) and, on macOS, the Xcode Command Line Tools. Steps, the output folder and release instructions are in [desktop/README.md](desktop/README.md).

Settings: `PORT` changes the port (8090 by default). `HOST` changes the address (127.0.0.1 by default). The server loads `.env` at start and does not override variables already set in your shell. `.env` is gitignored: never commit keys. Copy `.env.example` if you want one. Execution flags in it stay off by default.

Sessions need a native module, `node-pty`, to give each agent a real terminal. If it cannot load on your computer, the New session dialog says so and sessions do not start. The rest of Agent OS still works.

---

## How it works

```text
Agent OS window (Tauri 2 desktop shell)
  -> bundled Node 24 server (127.0.0.1, random port, per-launch login token)
       -> the agents' own official command-line tools
          hermes, openclaw, claude, codex, agent (Cursor)
```

The desktop app is a small native window around the same server and web UI that `npm start` gives you. It carries its own copy of Node. Your data stays in the same folder either way, so the app and `npm start` share agents, runs, sessions and settings. More detail: [desktop/README.md](desktop/README.md).

For a session, the server starts the agent in a pseudo-terminal (a pretend keyboard and screen for the program), keeps a copy of the screen so the window can close and come back, saves the output as a recording, and streams it to the page, where xterm.js draws it.

The stack: React 18, TypeScript and Vite on the front. Node and Express on the back. Node's built-in test runner. Tauri 2 for the desktop shell.

---

## Limits

- **Builds are unsigned.** Your OS will warn you on first launch (see Download).
- **Auto-update has been proven on one Mac only.** An installed v0.3.0 (Apple silicon) offered v0.3.1, installed it and restarted on 1 October 2026. It has not been tried on Intel Macs, Windows or Linux.
- **Hermes Agent: Setup treats Intel Macs as unsupported** and says so instead of installing.
- **Windows and Linux have not been hand-tested.** Intel Mac builds have not either.
- **Level 2 (Machine control) works on macOS only.**
- **Session recordings have no replay yet.** The Runs page lists them and offers Resume conversation, but there is no player and no Delete button in the app.
- **Agent OS does not tell you when an agent is waiting for you.** There is no alert, split view or changed-files panel in Sessions yet. A session reads "Live" while its program runs, even when the agent is only waiting at a question.
- **Codex and Hermes resume the most recent conversation in the folder,** not an exact one, because Agent OS cannot read their conversation ids when the session starts.
- **OpenClaw sessions start in your home folder.** The folder you pick is not used for OpenClaw, because OpenClaw's Gateway decides where its work happens, so the New session dialog does not offer a folder for it.
- **Stop cannot cancel a step that OpenClaw's Gateway is already running.** Agent OS closes the terminal and says OpenClaw may still be finishing its last step. A Claude Code task that you moved to the background with `/bg` may also keep running if Agent OS cannot find it.
- **Quitting from the Dock menu, the app switcher or by logging out does not ask first.** Live sessions end, and you can resume them from their recordings.
- **On Windows and Linux, opening Agent OS twice can mark the first one's live sessions as ended.** Two copies using the same data folder (or `npm start` next to the app) do not know about each other's sessions.
- **The Claude plan check cannot tell every sign-in apart.** Claude Code reports a sign-in to an Anthropic Console account (billed by usage) the same way as a plan sign-in, so in that one case the card cannot warn you.
- **The OpenClaw ChatGPT sign-in needs OpenClaw 2026.9.7 or newer.**
- **Team Room** works with Hermes Agent and OpenClaw only, and has been proven with test agents, not by hand with the real ones for this release.
- **The Labs pages** (including the dry-run Chat) are older pages. I did not re-audit them for this release, and they are not in the screenshots above.

---

## Older docs

These were written for v0.2, before the desktop app. They describe the older dashboard and may not match v0.4: [Product tour](docs/DEMO.md) · [What v1 includes](docs/V1.md) · [Setup guide](SETUP-GUIDE.md) · [Hosting](docs/HOSTING.md).

There is also a [static gallery](https://hharsha98.github.io/agent-os/) of v0.2 screenshots on GitHub Pages. It is screenshots only. It does not run anything.

---

## Optional: private self-host

Agent OS is a local app. Keep it on loopback. If you need it from another machine, use an SSH tunnel and read [docs/HOSTING.md](docs/HOSTING.md) first. Do not expose it to the public Internet. If you ever reverse-proxy it, add your hostname to `AGENT_OS_ALLOWED_HOSTS` and set up real authentication.

### Docker

Only if you already have Docker and want the server in a container:

```bash
cp .env.example .env
docker compose up --build
```

The host port is `127.0.0.1:8090`. Inside the container the server uses `HOST=0.0.0.0` so Docker can forward the port. Agent CLIs on your computer are **not** available inside the container, so it can only show them as not installed. Docker is not part of CI and was not re-tested for v0.4. Prefer `npm start`.

### Screenshot demo mode

`DEMO_PUBLIC=1` starts a sandboxed walkthrough with simulated agents, used for screenshot galleries. It is not a claim that anyone's agent is connected, and it keeps execution locked off. Do not publish that process.

```bash
DEMO_PUBLIC=1 HOST=127.0.0.1 PORT=8090 npm start
```

`npm run smoke:local`, `npm run smoke:public` and `npm run smoke:live` are older smoke scripts. CI runs the first two.

---

## Repo map

```text
src/                 Web UI (pages, Shell, components)
server/              Express server, run manager, agent adapters, setup assistant, safety gate
server/runtime/sessions/   Sessions: terminals, folder rule, recordings, Stop and quit
desktop/             Tauri desktop shell and its README
test/                Unit tests, with fake agents in test/fakes/
scripts/             Build, desktop packaging, version bump and smoke scripts
docs/                Screenshots, older docs, hosting notes, design specs
.github/workflows/   CI and the release workflow
```

---

## Contact

Questions or problems: mechaharsh@gmail.com

## License

MIT. See [LICENSE](LICENSE).

---

<p align="center">
  <sub>Local-first · MIT · <a href="https://github.com/hharsha98/agent-os">hharsha98/agent-os</a></sub>
</p>
