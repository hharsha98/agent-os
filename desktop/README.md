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
`npm run desktop:fetch-node -- --platform linux --arch x64`.

Day-to-day development: `npm run desktop:dev`. With no bundled resources it
falls back to your system `node` and the repo's own `server/index.js` and
`dist/` (run `npm run build` first).

## Tested on

- macOS 15, Apple silicon (arm64): built, launched with `open`, quit checks
  by hand.
- Windows and Linux: **not tested yet.** The project is set up to build there
  (CI is planned for the release phase), but nobody has run it.

## Unsigned builds

These builds are not signed with a paid developer certificate, so the operating
system warns on first launch:

- **macOS:** the app is ad-hoc signed only. Right-click `Agent OS.app`, choose
  **Open**, then **Open** again. (Or: System Settings > Privacy & Security >
  "Open Anyway".)
- **Windows:** SmartScreen says "Windows protected your PC". Click **More
  info**, then **Run anyway**.

## Updater

The in-app update banner (`src/ui/components/UpdateBanner.tsx`) checks for an
update at start and every 4 hours, and only installs when you click "Install &
restart". It never restarts on its own.

**Status: switched off, because there is no signing key yet.** Tauri's updater
only installs updates signed with a private key, and its plugin refuses to
start without the matching public key. No key has been generated, and none is
committed here.

How the build copes without one:

- `tauri.conf.json` has no `plugins.updater` block and no
  `bundle.createUpdaterArtifacts`.
- `main.rs` registers the updater plugin **only if** `plugins.updater.pubkey`
  is present in the config. Without it the app builds and runs normally, the
  banner's check fails quietly (one `[agent-os updater]` warning in the
  console) and the banner never shows.
- `capabilities/default.json` already grants the updater permissions, with the
  `remote` block that lets the local-server window use them. Do not remove it:
  without it updater calls are silently rejected.

To turn it on (release phase):

1. `npx tauri signer generate -w ~/.tauri/agent-os.key` and keep the private key
   and its password secret (a CI secret, never the repo).
2. Add to `tauri.conf.json`:
   `"plugins": { "updater": { "pubkey": "<contents of the .pub file>", "endpoints": ["<url of latest.json>"] } }`
   and `"createUpdaterArtifacts": true` under `bundle`.
3. Build with `TAURI_SIGNING_PRIVATE_KEY` (and `..._PASSWORD`) set, and publish
   `latest.json` plus the signed artifacts.

## Icons

`desktop/icon-source.svg` is the brand tile. Regenerate every size with
`npx tauri icon desktop/icon-source.svg -o desktop/src-tauri/icons` (then delete
the `android/` and `ios/` folders it creates; this is a desktop app).
