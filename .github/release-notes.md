**These builds are unsigned.** I have not paid for Apple or Microsoft developer certificates, so your computer will warn you the first time you open the app. The warning is expected. Here is how to get past it:

- **macOS:** right-click the app, choose **Open**, then click **Open** again (first launch only). On macOS 15 or newer it may still refuse: open **System Settings > Privacy & Security**, scroll down, and click **Open Anyway**.
- **Windows:** when SmartScreen says "Windows protected your PC", click **More info**, then **Run anyway**.
- **Linux:** an AppImage needs permission to run: `chmod +x Agent-OS_*.AppImage`, then double-click it or run it from a terminal.

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

Agent OS opens its own window and starts a small private server on your computer. You do not need to install Node or anything else first. The **Setup Assistant** checks your computer, offers to install Hermes Agent and OpenClaw (keeping any you already have), and helps you pick an AI brain: a free OpenRouter key or a local Ollama model. **Nothing is installed on your computer until you click for it.**

## Tested on

- macOS on Apple silicon (arm64): built and tested by hand.
- macOS Intel, Windows and Linux: built automatically by GitHub, **not tested by hand**. If something breaks, please tell me.

Questions or problems: mechaharsh@gmail.com
