// `npm run dev` starts the API server through this file. It marks the run as a
// development run, so the sessions WebSocket also accepts the Vite dev page's
// origin (http://127.0.0.1:5173 or http://localhost:5173). A packaged or
// production server ignores the flag (server/runtime/sessions/ws.js).
// Setting it here, instead of writing "AGENT_OS_DEV_ORIGIN=1 node ..." in
// package.json, works the same in every operating system's shell.
process.env.AGENT_OS_DEV_ORIGIN = "1";
await import("../server/index.js");
