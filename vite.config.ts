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
    server: {
      port: 5173,
      proxy: {
        "/api": `http://127.0.0.1:${apiPort}`
      }
    }
  };
});
