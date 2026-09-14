import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), "");
  const apiPort = Number(process.env.PORT || fileEnv.PORT || 8090);

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": `http://127.0.0.1:${apiPort}`
      }
    }
  };
});
