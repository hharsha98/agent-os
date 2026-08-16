import { promises as fs } from "node:fs";
import path from "node:path";
import { getMemoryState } from "./memory.js";
import { getMemoryContext } from "./memory-context.js";
import { ensureRuntimeStore, runtimePaths } from "./store.js";

const PARA_FOLDERS = ["inbox", "projects", "areas", "resources", "archive"];

function slug(value) {
  return String(value || "note")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "note";
}

function paraFor(item) {
  if (item?.archived) return "archive";
  const source = String(item?.source || "");
  const tags = item?.tags || [];
  if (source === "capture" || source === "journal" || tags.includes("capture")) return "inbox";
  if (source === "goal-loop" || source === "goals" || source === "kanban" || source === "swarm" || tags.includes("goals")) {
    return "projects";
  }
  if (source === "loop-desk" || source === "brain-loop" || source === "chat-loop" || tags.includes("briefing")) {
    return "areas";
  }
  if (source === "notebook" || source === "seo" || source === "studio") return "resources";
  return "inbox";
}

function markdownFor(item) {
  return [
    `# ${item.title || "Untitled"}`,
    "",
    `- source: ${item.source || "manual"}`,
    `- type: ${item.type || "episodic"}`,
    `- updated: ${item.updatedAt || ""}`,
    "",
    item.content || "",
    ""
  ].join("\n");
}

export async function exportVaultMarkdown() {
  await ensureRuntimeStore();
  const workspace = runtimePaths().workspace;
  const vaultRoot = path.join(workspace, "vault");
  for (const folder of PARA_FOLDERS) {
    await fs.mkdir(path.join(vaultRoot, folder), { recursive: true });
  }

  const [memory, context] = await Promise.all([
    getMemoryState(),
    getMemoryContext({ limit: 8 })
  ]);

  const written = [];

  if (context.briefing) {
    const relativePath = "vault/inbox/latest-briefing.md";
    await fs.writeFile(path.join(workspace, relativePath), [
      `# ${context.briefing.title}`,
      "",
      `Updated: ${context.briefing.updatedAt || ""}`,
      "",
      context.briefing.excerpt || "No briefing text yet.",
      ""
    ].join("\n"), "utf8");
    written.push({ relativePath, id: `workspace/${relativePath}` });
  }

  for (const item of (memory.memories || []).slice(0, 80)) {
    const folder = paraFor(item);
    const relativePath = `vault/${folder}/${slug(item.title)}-${String(item.id || "note").slice(-8)}.md`;
    await fs.mkdir(path.dirname(path.join(workspace, relativePath)), { recursive: true });
    await fs.writeFile(path.join(workspace, relativePath), markdownFor(item), "utf8");
    written.push({ relativePath, id: `workspace/${relativePath}` });
  }

  const indexPath = "vault/resources/index.md";
  await fs.writeFile(path.join(workspace, indexPath), [
    "# Vault export",
    "",
    "This is a local markdown snapshot of Agent OS Memory plus the latest Loop briefing.",
    "You can open workspace/vault later as an Obsidian vault. Obsidian is not connected.",
    "",
    `Exported: ${new Date().toISOString()}`,
    `Files: ${written.length}`,
    "",
    ...written.map((file) => `- ${file.relativePath}`),
    ""
  ].join("\n"), "utf8");
  written.push({ relativePath: indexPath, id: `workspace/${indexPath}` });

  return {
    ok: true,
    folder: "vault",
    publicPath: "workspace/vault",
    count: written.length,
    files: written,
    briefing: context.briefing,
    publicSummary: `Wrote ${written.length} markdown file(s) into workspace/vault. Obsidian is not connected.`
  };
}
