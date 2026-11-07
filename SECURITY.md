# Security

## How to report a problem

Please report a security problem privately, not in a public issue or pull request.

Email **mechaharsh@gmail.com** with "Agent OS security" in the subject. Tell me what you found, the version you tried (Agent OS, then About), your computer's system, and the steps to see it. A screenshot or a short note is enough. Please do not send passwords, API keys or private files.

This is a one-person project, so I answer when I can, usually within a few days. I will tell you when it is fixed, and I will credit you in the release notes if you want that.

## What Agent OS is, and what is in scope

Agent OS is a desktop app (Mac, Windows and Linux) and a local web app. It starts a small private server on your own computer, opens it in its own window, and runs coding agents (Claude Code, Codex, Cursor, Hermes, OpenClaw) in terminals inside it. The server listens on `127.0.0.1` only, behind a login code that is made fresh each time the app starts.

In scope:

- The server (`server/`) and the page it serves (`src/`), including the login code, the terminals and the files it reads or writes.
- The desktop shell (`desktop/`), the installers, and the update check.
- The release process in `.github/`, and the Docker image.
- Anything that makes the app run a command, open a file or reach the network when you did not ask it to.

Out of scope:

- The agents themselves (Claude Code, Codex, Cursor, Hermes, OpenClaw). Please report those to their own makers. If Agent OS uses one of them in an unsafe way, that is in scope.
- Problems that need someone to already control your computer or your user account.
- Missing Apple or Microsoft signing. The builds are unsigned on purpose (see below).

## The builds are unsigned: check your download

I have not paid for Apple or Microsoft developer certificates, so your computer will warn you the first time you open the app. To make sure a download is the file the release made, compare it with `SHA256SUMS.txt`, which sits next to the installers on the release page. Download both, open a terminal in the folder that holds them, and run the line for your system. It prints a long string of letters and numbers. Find your file's line in `SHA256SUMS.txt`: the two must match exactly.

- **Mac:** `shasum -a 256 "<the file you downloaded>"`
- **Linux:** `sha256sum "<the file you downloaded>"` (or `sha256sum -c SHA256SUMS.txt --ignore-missing`, which prints OK for each file it finds)
- **Windows (PowerShell):** `Get-FileHash ".\<the file you downloaded>" -Algorithm SHA256`

If they differ, delete the file and do not run it. Please tell me at the address above.

Updates inside the app are checked against a signing key before they are installed. That is a separate check from `SHA256SUMS.txt`.
