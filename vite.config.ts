import { readFileSync } from "node:fs";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), "");
  const parsedPort = Number(process.env.PORT || fileEnv.PORT || 8090);
  const apiPort = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8090;

  return {
    plugins: [react()],
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    build: {
      // Vite's default (es2020 with the same browsers) makes esbuild rewrite
      // `x ||= {}`, and in xterm's DECRQM handler (`let r; (...)(r ||= {})`)
      // the minified rewrite assigns to a name that does not exist, so the
      // first DECRQM query a real agent sends (Claude Code asks two at start)
      // throws and freezes the page's terminal for good. es2021 keeps `||=`
      // as it is; the browsers are Vite's own, Firefox 79 being the first
      // with `||=`. test/build-target.test.js checks this.
      target: ["es2021", "chrome87", "edge88", "firefox79", "safari14"]
    },
    server: {
      port: 5173,
      // The sessions WebSocket trusts exactly the dev origins on :5173
      // (server/runtime/sessions/ws.js). If another project holds 5173, Vite
      // must stop with an error, not quietly move to 5174, where every terminal
      // attach would be refused.
      strictPort: true,
      proxy: {
        // The object form, so the proxy also carries WebSocket upgrades (a
        // session's terminal, /api/sessions/:id/attach). changeOrigin keeps the
        // Host the API server checks (127.0.0.1:<apiPort>); the page's Origin
        // (http://127.0.0.1:5173) reaches the server unchanged, and the server
        // accepts it only when `npm run dev` set AGENT_OS_DEV_ORIGIN=1.
        "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true, ws: true }
      }
    }
  };
});
