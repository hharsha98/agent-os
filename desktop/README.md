# Agent OS desktop app

A double-clickable Agent OS for macOS, Windows and Linux. It is a small
native window (Tauri 2) wrapped around the same Node server and web UI you get
from `npm start`, with its own private copy of Node 24 inside. Nothing to
install first.

## How it works

```text
Agent OS.app
  |-- Rust shell (desktop/src-tauri/src/main.rs)
  |     1. picks a random login token (32 bytes, never logged)
  |     2. starts   resources/node/bin/node  resources/server/server.mjs
  |                   PORT=0                     (the OS picks a free port)
  |                   AGENT_OS_TOKEN=<token>
  |                   AGENT_OS_STATIC_DIR=resources/server/web
  |                   AGENT_OS_PACKAGED=1
  |                   PATH = your usual tool folders + the inherited PATH
  |     3. waits (max 20 s) for the server to print  AGENT_OS_READY:<port>
  |     4. opens the window at  http://127.0.0.1:<port>/?launch=<token>&desktop=1
  |        (the server turns ?launch= into a secure cookie; you are logged in)
  |     5. on quit, asks the server to stop (SIGTERM, up to 5 s so it can end
  |        any agent runs it started), then force-kills it
  `-- resources/
        node/    the app's own Node 24 (separate from ~/.agent-os/node, which
                 Setup installs for OpenClaw)
        server/  server.mjs (one esbuild file) + web/ (the built UI)
```

Your data stays where it always was (`AGENT_OS_HOME` is left unset), so the
app and `npm start` share the same agents, runs and settings.

The server is stopped on every way of quitting: Cmd+Q, closing the window,
and a plain `kill <pid>` of the app (a signal thread covers that last one). On
Windows the whole process tree is ended with `taskkill /T /F`.

If something goes wrong at start-up the loading page shows a plain-English
message (the server crashed, with its last output, or it took longer than 20
seconds).

## Build it

You need Node 22+ (to run the build), Rust (https://rustup.rs) and, on macOS,
the Xcode Command Line Tools.

```bash
npm install
npm run desktop:build
```

That runs, in order:

1. `npm run build`, then `npm run build:server-bundle` (UI + single-file server)
2. copies `build/server` to `desktop/src-tauri/resources/server`
3. `npm run desktop:fetch-node` if the bundled Node is missing: downloads Node
   from nodejs.org, **checks its SHA-256 against that release's
   `SHASUMS256.txt`** (aborts on mismatch) and keeps only the `node` binary.
   The pinned version is the `NODE_VERSION` constant in `scripts/fetch-node.mjs`.
   Downloads are cached in `desktop/.cache/` (git-ignored).
4. `tauri build`

Output (macOS): `desktop/src-tauri/target/release/bundle/macos/Agent OS.app`
and `.../bundle/dmg/Agent OS_<version>_<arch>.dmg`.

To build for another machine's CPU, fetch its Node first, for example
`npm run desktop:fetch-node -- --platform linux --arch x64`, then
`node scripts/prepare-desktop.mjs --skip-node` so prepare keeps it.

Day-to-day development: `npm run desktop:dev`. With no bundled resources it
falls back to your system `node` and the repo's own `server/index.js` and
`dist/` (run `npm run build` first).

## Tested on

- macOS 15, Apple silicon (arm64): built, launched with `open`, quit checks
  by hand.
- Intel Mac, Windows and Linux: built by the release workflow, but **not
  hand-tested** (see Releasing).

## Unsigned builds

These builds are not signed with a paid developer certificate, so the operating
system warns on first launch:

- **macOS:** the app is ad-hoc signed only. Right-click `Agent OS.app`, choose
  **Open**, then **Open** again. (Or: System Settings > Privacy & Security >
  "Open Anyway".)
- **Windows:** SmartScreen says "Windows protected your PC". Click **More
  info**, then **Run anyway**.
- **Linux:** make the AppImage runnable first: `chmod +x Agent-OS_*.AppImage`.

## Updater

The in-app update banner (`src/ui/components/UpdateBanner.tsx`) checks for an
update at start and every 4 hours, and only installs when you click "Install &
restart". It never restarts on its own.

**Status: on, and proven once.** Tauri's updater only installs updates
signed with a private key, and its plugin refuses to start without the
matching public key. The public half is in `desktop/updater-pubkey.txt`; the
private half is a GitHub Actions secret (never committed). On 1 October 2026
an installed v0.3.0 on an Apple-silicon Mac showed the banner, installed
v0.3.1 and restarted. Intel Mac, Windows and Linux updates are untested.

How a build copes without a key (for example a local `npm run desktop:build`):

- `tauri.conf.json` has no `plugins.updater` block and no
  `bundle.createUpdaterArtifacts`.
- `main.rs` registers the updater plugin **only if** `plugins.updater.pubkey`
  is present in the config. Without it the app builds and runs normally, the
  banner's check fails quietly (one `[agent-os updater]` warning in the
  console) and the banner never shows.
- `capabilities/default.json` already grants the updater permissions, with the
  `remote` block that lets the local-server window use them. Do not remove it:
  without it updater calls are silently rejected.

To turn it on, follow "One-time key setup" under **Releasing** below. The
release workflow then adds the `plugins.updater` block and
`createUpdaterArtifacts` for you at build time (via a temporary `--config`
file), so `tauri.conf.json` stays as it is.

## Releasing

Pushing a tag like `v0.4.0` makes GitHub Actions
(`.github/workflows/release.yml`) build the app on four runners and attach the
installers to a **draft** GitHub Release:

| Leg | Runner | Output |
| --- | --- | --- |
| macOS Apple Silicon | `macos-latest` | `.dmg` |
| macOS Intel | `macos-latest`, cross-compiled | `.dmg` |
| Linux | `ubuntu-22.04` | `.deb`, `.AppImage` |
| Windows | `windows-latest` | NSIS `setup.exe` (no MSI: WiX fails on this app) |

Each leg downloads the Node for its own target with
`node scripts/fetch-node.mjs --platform <p> --arch <a>` (SHA-256 checked), then
runs `node scripts/prepare-desktop.mjs --skip-node` so the runner's own Node is
never bundled by mistake. The release notes shown on the Release come from
`.github/release-notes.md`; edit that file to change them.

The workflow runs in three stages so there is exactly one draft and one
`latest.json`:

1. `create-release` makes the one draft for the tag first (or reuses it if you
   re-run). It stops with a clear message if that version is already published.
2. The four builds above each upload their installers (and `.sig` signature
   files) into that same draft.
3. `updater-json` runs last and writes `latest.json` from the files that are
   there. It checks that all four computers (Apple Silicon Mac, Intel Mac,
   Linux, Windows) are present and fails without uploading if one is missing.

### One-time key setup (the owner does this, once)

The in-app updater only installs updates signed with your private key, so you
need a key pair. Nobody else, including CI scripts and AI helpers, should ever
see the private key.

```bash
npx tauri signer generate -w ~/.tauri/agent-os.key
```

It asks for a password (remember it) and writes two files:
`~/.tauri/agent-os.key` (private) and `~/.tauri/agent-os.key.pub` (public).

1. Paste the **entire contents of `agent-os.key.pub`** into
   `desktop/updater-pubkey.txt`, replacing the placeholder, and commit it. The
   public key is safe to publish.
2. In the GitHub repo: Settings > Secrets and variables > Actions > New
   repository secret. Add `TAURI_SIGNING_PRIVATE_KEY` (the contents of
   `agent-os.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the password).
3. Back up `agent-os.key` and the password somewhere safe (a password manager).
   **If you lose the private key, apps that are already installed can never
   auto-update again**, because they only trust updates signed by it. Those
   users would have to download a new installer by hand.

Until both the secret and a real public key are in place, releases still work.
The workflow just prints "Updater: OFF" and builds without auto-update.

### Cutting a release

```bash
node scripts/bump-version.mjs 0.4.0   # package.json, tauri.conf.json, Cargo.toml (+ lock files)
git add -A
git commit -m "Release v0.4.0"
git tag v0.4.0
git push origin main v0.4.0           # pushing the tag starts the build
```

1. Watch the run in the repo's Actions tab (about 15 to 25 minutes; the four
   legs run side by side and one failing does not cancel the others).
2. When it finishes, open Releases. You will see a **Draft** release named
   "Agent OS v0.4.0". Review it, then click **Publish release**.

`node --test test/release-config.test.js` (part of `npm test`) fails if the
three versions disagree, so a forgotten bump is caught before you tag.

### What to test on the draft before publishing

- All installers are attached: two `.dmg` (aarch64 and x64), the `.deb`,
  the `.AppImage` and the Windows `setup.exe`. If the updater is on there should
  also be `.sig` files and a `latest.json`.
- Download the Apple Silicon DMG on a Mac, open it, and go through the
  right-click > Open steps from the release notes. The window should open and the
  Setup Assistant should load.
- If you have access, try one of: the Windows `setup.exe` (SmartScreen steps,
  then launch), or the Linux AppImage (`chmod +x`, then launch).
- Read the release notes on the draft once; they are the first thing a user
  sees.
- Updater: with a published release that is newer than an installed copy, the
  in-app banner should appear and "Install & restart" should work.

## Icons

`desktop/icon-source.svg` is the brand tile. Regenerate every size with
`npx tauri icon desktop/icon-source.svg -o desktop/src-tauri/icons` (then delete
the `android/` and `ios/` folders it creates; this is a desktop app).
