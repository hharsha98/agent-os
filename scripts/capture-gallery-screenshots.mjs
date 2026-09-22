import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

// Always write into the repo docs/screenshots, even if this script is copied elsewhere.
const root = process.env.AGENT_OS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "docs", "screenshots");
const base = process.env.BASE_URL || "http://127.0.0.1:8090";

const pages = [
  { page: "mission", file: "mission.png", wait: "MISSION CONTROL" },
  { page: "chat", file: "chat.png", wait: "UNIFIED CHAT" },
  { page: "workspace", file: "workspace.png", wait: "WORKSPACE" },
  { page: "machine", file: "machine.png", wait: "MACHINE CONTROL" }
];

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const tab = await context.newPage();

for (const item of pages) {
  await tab.goto(`${base}/?page=${item.page}`, { waitUntil: "networkidle" });
  await tab.getByText(item.wait, { exact: false }).first().waitFor({ timeout: 15000 });
  await tab.waitForTimeout(600);
  const target = path.join(out, item.file);
  await tab.screenshot({ path: target, fullPage: false });
  console.log("wrote", target);
}

await browser.close();
