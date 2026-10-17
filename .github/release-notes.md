**These builds are unsigned.** I have not paid for Apple or Microsoft developer certificates, so your computer will warn you the first time you open the app. The warning is expected. Here is how to get past it:

- **macOS:** right-click the app, choose **Open**, then click **Open** again (first launch only). On macOS 15 or newer it may still refuse: open **System Settings > Privacy & Security**, scroll down, and click **Open Anyway**.
- **Windows:** when SmartScreen says "Windows protected your PC", click **More info**, then **Run anyway**.
- **Linux:** an AppImage needs permission to run: `chmod +x Agent-OS_*.AppImage`, then double-click it or run it from a terminal.

## What's new in 0.4.0

**Sessions.** Each agent now has its own real terminal inside Agent OS. New session asks for an agent and a folder, then runs your installed Claude Code, Codex, Cursor, Hermes or OpenClaw with your own sign-in and settings (if you picked an OpenRouter or Local brain for Claude Code or Codex in Agent OS, the session uses that brain), the way Terminal would.

- A session keeps running when you close the window on macOS. Quitting asks first and names the sessions that are still live.
- Every session is recorded on your computer (what the terminal showed, including anything you typed that appeared on screen) and listed in Runs, under "Session recordings". **Resume conversation** brings an ended session back.
- **Stop** ends the agent and the commands it started. **Hold to stop all** in the top bar stops every session and every run.
- Agent OS never types an answer into an agent for you.

**Your plan.** On OpenClaw's Agents page and in Setup's "AI brain" step, a new card lets OpenClaw use the Claude plan you already pay for (through your own Claude Code) or your ChatGPT plan (OpenClaw's own "Sign in with ChatGPT", inside the card). It lists the models your account offers, asks you to tick OpenClaw's risk notice, and checks that the agent can answer before it says done. For Hermes, "Choose in Hermes" and "Add a sign-in in Hermes" open Hermes's own tools in Terminal.app. Fable models use usage credits.

**Team Room changes.** Team Room was already in the menu in 0.3.x (the old README wrongly said it was not). In 0.4.0 an agreed file is no longer saved on its own: nothing is saved until you press Approve, the room pauses and its clock stops while it waits. Undo still puts a saved file back.

**A new look.** Dark, with a cobalt-blue accent, a new logo and bundled fonts.

**Also new:** Setup installs all five agents (it keeps any you already have) and signs in to Claude Code, Codex and Cursor. Connecting OpenRouter takes one click in your browser. Runs can use a Plan, OpenRouter or Local brain. ⌘K (Ctrl+K on Windows and Linux) opens a search for pages and actions.

**Fixes worth naming:**

- Setup no longer answers an updater's questions for you (the `--yes` flag is gone), and it no longer offers a Hermes update step.
- Level 0, "Look only", now also blocks new sessions, and Setup's and the Agents page's hello checks (which start an agent) are skipped there.
- Team Room's Undo refuses when a file changed after the agent saved it.
- A Setup retry after a failed job waits for that job's final save, and never runs the Hermes installer again.

## Known limits

- Session recordings have no replay yet, and there is no Delete button for them in the app.
- Agent OS does not tell you when an agent is waiting for you. There is no alert, split view or changed-files panel in Sessions yet.
- Codex and Hermes resume the most recent conversation in the folder, not an exact one.
- OpenClaw sessions start in your home folder. OpenClaw's Gateway decides where its work happens, so the New session dialog does not offer a folder for it.
- Stop cannot cancel a step that OpenClaw's Gateway is already running. A Claude Code task moved to the background with `/bg` may keep running if Agent OS cannot find it.
- Quitting from the Dock menu, the app switcher or by logging out does not ask first. Live sessions end, and you can resume them.
- On Windows and Linux, closing the window quits (after asking), and opening Agent OS twice can mark the first one's live sessions as ended.
- The OpenClaw ChatGPT sign-in needs OpenClaw 2026.9.7 or newer.
- The Claude plan check cannot tell a Claude Console (usage-billed) sign-in from a plan sign-in.
- Team Room has been tested with test agents. I have not hand-tested a full room with the real Hermes and OpenClaw for this release.

## Which file do I download?

| Your computer | Download |
| --- | --- |
| Mac with an Apple chip (M1, M2, M3, M4...) | the `.dmg` with `aarch64` in its name |
| Mac with an Intel chip | the `.dmg` with `x64` in its name |
| Windows 10 or 11 | the `setup.exe` |
| Linux (Debian, Ubuntu and friends) | the `.deb` |
| Linux (anything else) | the `.AppImage` |

Not sure which Mac you have? Apple menu > About This Mac. "Chip" means Apple Silicon; "Processor" means Intel.

## What happens the first time you open it

Agent OS opens its own window and starts a small private server on your computer. You do not need to install Node or anything else first. The **Setup Assistant** checks your computer, offers to install the five agents (keeping any you already have), and helps you pick an AI brain: a free OpenRouter key, a local Ollama model, or, for OpenClaw, a plan you already pay for. **Nothing is installed on your computer until you click for it.**

## Tested on

- macOS on Apple silicon (arm64): the 0.4.0 work was tested by hand on the author's Mac. An earlier desktop build of it (made before the plan-brains changes) ran with a live Claude Code session open (nothing was sent to it): the quit question, Keep running, Quit and reopen, and closing the window all behaved as described above. Each of the five agents was opened and stopped in a session on the author's Mac. This release's installer is built by GitHub and was not installed by hand before publishing.
- macOS Intel, Windows and Linux: built automatically by GitHub, **not tested by hand**. If something breaks, please tell me.

Questions or problems: mechaharsh@gmail.com
