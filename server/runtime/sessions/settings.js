// The stored session settings (spec "Browser terminal", H4). Only the setting
// that changes how an agent starts lives on the server: "Use Claude Code's
// fullscreen view in Agent OS", off by default. The terminal's own settings
// (kitty keyboard, WebGL) stay in the browser.
import path from "node:path";
import { ensureRuntimeStore, readJson, runtimePaths, writeJson } from "../store.js";
import { sessionError } from "./errors.js";

const KEYS = ["claudeFullscreen"];

function settingsFile() {
  return path.join(runtimePaths().config, "sessions.json");
}

// Off when the file is missing, broken, or holds anything but true.
export async function readSessionSettings() {
  const raw = await readJson(settingsFile(), null);
  return { claudeFullscreen: raw?.claudeFullscreen === true };
}

// Only the known boolean key is accepted; anything else is refused (the route
// answers 400) and nothing is written. The file is private (0600, writeJson).
export async function writeSessionSettings(patch) {
  const keys = patch && typeof patch === "object" && !Array.isArray(patch) ? Object.keys(patch) : [];
  if (!keys.length || keys.some((key) => !KEYS.includes(key) || typeof patch[key] !== "boolean")) {
    throw sessionError(400, "invalid_settings", "Only the Claude Code fullscreen setting (on or off) can be changed here.");
  }
  const next = { ...(await readSessionSettings()), ...patch };
  await ensureRuntimeStore();
  await writeJson(settingsFile(), next);
  return next;
}
