import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfiguredValue, getStoredConnectionConfig } from "../server/runtime/connections.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const builderRoot = path.join(root, "vendor", "open-agent-builder");
const port = process.env.HERMES_BUILDER_PORT || "3100";

const stored = await getStoredConnectionConfig();
const builderConfig = stored["firecrawl-builder"] || {};
const configIds = ["firecrawl-builder", "provider-convex", "provider-clerk", "provider-firecrawl", "provider-openai", "provider-anthropic", "provider-gemini"];
function valueFor(key) {
  for (const id of configIds) {
    const value = getConfiguredValue(stored, id, key);
    if (value) return value;
  }
  return process.env[key];
}
const mergedEnv = {
  ...process.env,
  ...builderConfig,
  NEXT_PUBLIC_CONVEX_URL: valueFor("NEXT_PUBLIC_CONVEX_URL"),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: valueFor("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"),
  CLERK_SECRET_KEY: valueFor("CLERK_SECRET_KEY"),
  CLERK_JWT_ISSUER_DOMAIN: valueFor("CLERK_JWT_ISSUER_DOMAIN"),
  FIRECRAWL_API_KEY: valueFor("FIRECRAWL_API_KEY"),
  ANTHROPIC_API_KEY: valueFor("ANTHROPIC_API_KEY") || stored.claude?.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: valueFor("OPENAI_API_KEY") || stored.codex?.OPENAI_API_KEY,
  GEMINI_API_KEY: valueFor("GEMINI_API_KEY") || stored.gemini?.GEMINI_API_KEY,
  GROQ_API_KEY: valueFor("GROQ_API_KEY"),
  ARCADE_API_KEY: valueFor("ARCADE_API_KEY")
};
const childEnv = Object.fromEntries(
  Object.entries(mergedEnv).filter(([, value]) => value != null && String(value) !== "")
);

const child = spawn("npx", ["next", "dev", "-p", port], {
  cwd: builderRoot,
  env: childEnv,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
