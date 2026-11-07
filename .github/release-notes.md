**These builds are unsigned.** I have not paid for Apple or Microsoft developer certificates, so your computer will warn you the first time you open the app. The warning is expected. Here is how to get past it:

- **macOS:** right-click the app, choose **Open**, then click **Open** again (first launch only). On macOS 15 or newer it may still refuse: open **System Settings > Privacy & Security**, scroll down, and click **Open Anyway**.
- **Windows:** when SmartScreen says "Windows protected your PC", click **More info**, then **Run anyway**.
- **Linux:** an AppImage needs permission to run: `chmod +x Agent.OS_*.AppImage`, then double-click it or run it from a terminal.

To check that a download is the file this release made, compare it with `SHA256SUMS.txt` on this page (how: see `SECURITY.md`).

**On Windows, quit Agent OS and run the new `setup.exe` by hand:** an update from inside the app may be blocked by the old version still running. (See Known limits.)

## What's new in 0.4.1

This is a security release. After 0.4.0 I had the app, the release pipeline and everything public in the repo reviewed, and fixed what the review found. I know of no one being harmed by any of this. Update if you can.

**One thing to know if you use Hermes.** 0.4.0 said Hermes would "always ask before deleting". That was not true. Hermes only asks about commands its own checks flag, such as `rm -r`, `git clean` or `DROP TABLE`. A plain `rm` of one file, `rmdir` or `git restore .` is not flagged, so it runs without asking. Hermes itself has not changed; Agent OS's words have. That choice now reads "Ask before flagged deletes". OpenClaw's reviewer also judges each command, so a plain delete of one file can run there without asking too.

**Fixed in the app:**

- A repo's `.claude/settings.json` could freeze Agent OS when you opened a Claude Code session in that folder, including Hold to stop all. It can't any more.
- A web page open in your browser could make Agent OS start your installed agents' programs with `--version`, again and again, with no login. It could not read anything or choose a command. That route no longer starts anything.
- A file Agent OS couldn't read, opened in Workspace, could crash the server and end every session.
- A request with a saved login could read a `.json` file outside Agent OS's folder, or delete such a file and a folder beside it, through a crafted workflow name.
- A saved API key could be sent to an address given in a test request.
- Secrets are now kept out of helper programs, notifications and saved run output more thoroughly, and more kinds of key are recognised.
- An OpenClaw approval with no real description can now only be denied.

**New protections:**

- A program in a terminal can still put text on your clipboard, as in most terminals, but Agent OS now tells you when it does, and a program can no longer empty it.
- A terminal link whose words differ from its address now shows the real address and asks before opening.
- The app's page now has a strict content policy: only its own scripts run, and it talks only to its own server.
- Only one copy of the desktop app runs at a time. A second launch brings the first window forward, so a second copy can't mark live sessions as ended.
- Labs, AI APIs no longer loads logos from other websites.

**If you run from source or host it yourself:**

- The optional builder add-on (`vendor/open-agent-builder`) is removed. It listened on the whole network, and its packages had a critical remote-code flaw. It was never in the desktop app.
- Admin-token mode now requires the token on more read routes, and the address parameter `?adminToken=` is gone if you used it. Demo mode can no longer run installers.
- The Docker image moved to Node 24 and no longer runs as root.

**The release pipeline:** installers are built with the exact tools in the repo's lockfile, every GitHub Action is pinned to one commit, and the bundled Node is checked against hashes kept in the repo. Before this release, an automatic check built all four installers, then installed and started each one on a real Windows, Linux, Intel Mac and Apple silicon Mac machine.

**Also new:** the third-party licence notices now ship inside the app, `SHA256SUMS.txt` lets you check a download, and `SECURITY.md` says how to report a problem. Third-party packages moved to fixed versions.

## What was new in 0.4.0

**Sessions.** Each agent now has its own real terminal inside Agent OS. New session asks for an agent and a folder, then runs your installed Claude Code, Codex, Cursor, Hermes or OpenClaw with your own sign-in and settings (if you picked an OpenRouter or Local brain for Claude Code or Codex in Agent OS, the session uses that brain), the way Terminal would. For Claude Code it also passes its own small settings file: hooks that only tell Agent OS what Claude is doing, such as asking for permission, and a status-line wrapper for the Live meter that still runs your own status line. Your own Claude settings are not changed.

- A session keeps running when you close the window on macOS. Quitting asks first and names the sessions that are still live. It also asks when an agent's update is running.
- Every session is recorded on your computer (what the terminal showed, including anything you typed that appeared on screen) and listed in Runs, under "Session recordings". **Replay** plays one back, read-only, at 1×, 10× or 30×. **Delete recording** removes it (off while the session runs). **Resume conversation** brings an ended session back.
- **Stop** ends the agent and the commands it started. **Hold to stop all** in the top bar stops every session and every run.
- Nothing answers for you. Agent OS passes on what you type, plus the small replies a terminal gives its program. It types text in one case, when you press for it: a hand-off, hand-over or keep-going note goes into the agent's prompt and is never sent, so you read it and press Enter yourself. An OpenClaw request is answered only when you press Allow once or Deny on its card.

**Alerts.** An agent that needs you gets an amber marker on its tab, a row in Home's "Waiting for you" strip and a badge in the top bar. In the desktop app you also get a notification when the window is hidden or not in front (macOS asks once). Claude Code's alerts start after you trust the folder in Claude. Alerts for Hermes and Cursor are basic: Agent OS hears only a bell or a sign in the title, which may also mean the agent finished.

**More in Sessions.**

- **Split view:** two sessions side by side with a divider, kept per window.
- **Files changed:** in a git project, the side panel lists the files the session changed, with + and − counts and a read-only diff.
- **Hand-off:** "Send to Codex for review" and "Send to Claude Code" type the list of changed files into the other agent and stop. They never press Enter.
- **Separate copies:** when a live session already uses a git project's folder, New session offers a separate copy (a git worktree on a new branch, `agentos/<agent>-<n>`) or the same folder. OpenClaw never gets the offer.
- **Keep going:** a Claude Code or Codex session at a plan limit reads Held and offers "Keep going on OpenRouter" after you confirm. Claude Code continues the same conversation on an Anthropic model. Codex starts a new session with a summary typed in, not sent. It needs an OpenRouter key you saved in Setup.
- **OpenClaw approval cards:** when OpenClaw asks to run a command, its card shows the command, with Allow once and Deny. A command too long to show in full (over 4,000 characters) can only be denied there.

**Agent updates.** The Agents page, in the desktop app, shows the latest version of each agent, with **Update** (it asks first) and **Check for updates**. An update uses the agent's own updater. It never stops a session: an open one keeps running on its old version, and **Restart session** offers to restart it on the new one, in the same tab, after you confirm. A dot in the sidebar footer shows when any agent has an update. Setup can also offer an update as a choice next to Keep. Hermes's update is offered only when its folder is an unchanged official copy, and it runs in a terminal you can type into.

**Ask only for risky commands.** On the Agents page, on your click: OpenClaw can run routine commands on its own and ask only about risky ones, and Hermes can do the same (its smart mode, plus a rule to ask about flagged deletes; see What's new in 0.4.1). The Safety page words each row by the mode that is on.

**Your plan.** On OpenClaw's Agents page and in Setup's "AI brain" step, a new card lets OpenClaw use the Claude plan you already pay for (through your own Claude Code) or your ChatGPT plan (OpenClaw's own "Sign in with ChatGPT", inside the card). It lists the models your account offers, asks you to tick OpenClaw's risk notice, and checks that the agent can answer before it says done. For Hermes, "Choose in Hermes" and "Add a sign-in in Hermes" open Hermes's own tools in Terminal.app. Fable models use usage credits.

**Team Room changes.** Team Room was already in the menu in 0.3.x (the old README wrongly said it was not). In 0.4.0 an agreed file is no longer saved on its own: nothing is saved until you press Approve, the room pauses and its clock stops while it waits. Undo still puts a saved file back.

**A new look.** Dark, with a cobalt-blue accent, a new logo and bundled fonts.

**Also new:** Setup installs all five agents (it keeps any you already have) and signs in to Claude Code, Codex and Cursor. Connecting OpenRouter takes one click in your browser. Runs can use a Plan, OpenRouter or Local brain. ⌘K (Ctrl+K on Windows and Linux) opens a search for pages and actions.

**Fixes worth naming:**

- Setup no longer answers an updater's questions for you (the `--yes` flag is gone), and it offers a Hermes update only when its folder is an unchanged official copy, in a terminal you can type into.
- Level 0, "Look only", now also blocks new sessions, and Setup's and the Agents page's hello checks (which start an agent) are skipped there.
- Team Room's Undo refuses when a file changed after the agent saved it.
- A Setup retry after a failed job waits for that job's final save, and never runs the Hermes installer again.
- An OpenClaw approval card shows the whole command and deletes no text from it. Control and invisible characters show as visible marks.
- On Windows, agents installed with npm (Codex, for example) are now started through their real program, with no shell. See Known limits.
- The Mac app now declares that it needs macOS 13.5 or newer, which is what its bundled Node needs.

## Known limits

- On Windows, quit Agent OS and run the new `setup.exe` by hand: an update from inside the app may be blocked by the old version still running. This comes from reading the updater's code and the installer's behaviour, not from running it on Windows.
- On Windows, agents installed with npm now start through a route that only CI has tried. npm puts a `.cmd` file beside each such agent. Agent OS reads that file, never runs it, and starts the program it points to directly. An automatic test in CI's Windows job starts a fake one. No person has tried it on a real Windows computer.
- Alerts depend on the agent. Hermes and Cursor are basic (a bell or a title sign, which may also mean it finished), and a Hermes or Cursor session can read "Live" while it waits.
- OpenClaw's approval cards need its Control UI or Mac app open. Without one, OpenClaw says no to commands that need approval, and no card shows.
- Agent OS can't ask for Cursor's latest version. Cursor's own updater looks when you press Update.
- Hermes's Update is offered only for an unchanged official copy, and its real update has not been run (see Tested on).
- An update on the Agents page has no Cancel. Stopping an agent's own updater half way can leave it half-updated.
- Codex and Hermes resume the most recent conversation in the folder, not an exact one.
- OpenClaw sessions start in your home folder. OpenClaw's Gateway decides where its work happens, so the New session dialog does not offer a folder for it.
- Stop cannot cancel a step that OpenClaw's Gateway is already running. A Claude Code task moved to the background with `/bg` may keep running if Agent OS cannot find it.
- Quitting from the Dock menu, the app switcher or by logging out does not ask first. Live sessions end, and you can resume them.
- On Windows and Linux, closing the window quits (after asking). Opening Agent OS a second time now brings the first window forward; on Linux that needs a desktop session bus, and without one two copies can still run and mark each other's sessions as ended.
- The OpenClaw ChatGPT sign-in needs OpenClaw 2026.9.7 or newer.
- The Claude plan check cannot tell a Claude Console (usage-billed) sign-in from a plan sign-in.
- Team Room has been tested with test agents. I have not hand-tested a full room with the real Hermes and OpenClaw for this release.

## Which file do I download?

| Your computer | Download |
| --- | --- |
| Mac with an Apple chip (M1, M2, M3, M4...), macOS 13.5 or newer | the `.dmg` with `aarch64` in its name |
| Mac with an Intel chip, macOS 13.5 or newer | the `.dmg` with `x64` in its name |
| Windows 10 or 11 | the `setup.exe` |
| Linux (Debian, Ubuntu and friends) | the `.deb` |
| Linux (anything else) | the `.AppImage` |

Not sure which Mac you have? Apple menu > About This Mac. "Chip" means Apple Silicon; "Processor" means Intel.

## What happens the first time you open it

Agent OS opens its own window and starts a small private server on your computer. You do not need to install Node or anything else first. The **Setup Assistant** checks your computer, offers to install the five agents (keeping any you already have), and helps you pick an AI brain: a free OpenRouter key, a local Ollama model, or, for OpenClaw, a plan you already pay for. **Nothing is installed on your computer until you click for it.**

The desktop app does look for new agent versions by itself, and changes nothing when it does. At start and every 24 hours it asks the npm registry about the latest Claude Code and Codex, and runs `openclaw update --dry-run --json` and `hermes update --check`. It asks only about agents you have installed. For Claude Code it also reads one setting from your Claude `settings.json`, your update channel, and nothing else in that file. For Hermes it reads the state of its folder with read-only git commands.

## Tested on

- Automated tests: 2,194 tests. On the author's Mac: 2,189 pass, 5 skipped, 0 fail. They use fake agents.
- macOS on Apple silicon (arm64): the 0.4.0 work was tested by hand on the author's Mac, on earlier builds. An earlier desktop build (made before the plan-brains changes) ran with a live Claude Code session open (nothing was sent to it): the quit question, Keep running, Quit and reopen, and closing the window all behaved as described above. Each of the five agents was opened and stopped in a session. On 31 October, with real Claude Code, Hermes and OpenClaw: alerts, Claude Code's Keep going on OpenRouter (the plan limit was staged, not real), OpenClaw's approval cards, and macOS notifications from the built desktop app. On 5 November, the Update button was run for Claude Code, Codex, OpenClaw and Cursor through Agent OS on the author's Mac, and each open session was restarted onto the new version. Codex and OpenClaw were really moved by it; Claude Code's and Cursor's own updaters had already moved them. **Hermes's update was never run for real, by my choice; only its check was.** The fixes made after those checks, in the final review of 6 November, are covered by the automated tests only. This release's installer is built by GitHub and was not installed by hand before publishing.
- macOS Intel, Windows and Linux: built automatically by GitHub, **not tested by hand**. If something breaks, please tell me.

Questions or problems: mechaharsh@gmail.com
