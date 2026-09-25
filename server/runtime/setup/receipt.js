// The setup receipt: an append-only, plain-English audit trail of every
// install/update the Setup Assistant performed, plus the official uninstall
// steps for each -- so "what did this touch, and how do I undo it" always
// has an answer.
import path from "node:path";
import { readJson, runtimePaths, writeJson } from "../store.js";

function receiptPath() {
  return path.join(runtimePaths().root, "setup", "receipt.json");
}

export function officialUninstallSteps(agentId) {
  if (agentId === "hermes") {
    return [
      "hermes uninstall --yes",
      "If that CLI is unavailable: stop the gateway, then remove ~/.local/bin/hermes and ~/.hermes/hermes-agent",
      "Optionally also remove ~/.hermes entirely (config, sessions, memories)"
    ];
  }
  if (agentId === "openclaw") {
    return ["openclaw uninstall --all --yes --non-interactive", "npm rm -g openclaw", "Optionally also remove ~/.openclaw"];
  }
  if (agentId === "managed-node") {
    return ["Delete ~/.agent-os/node* (or %LOCALAPPDATA%\\AgentOS\\node* on Windows)"];
  }
  return [];
}

export async function readReceipt() {
  return (await readJson(receiptPath(), [])) || [];
}

export async function appendReceiptEntry(entry) {
  const current = await readReceipt();
  const record = {
    at: new Date().toISOString(),
    agentId: entry.agentId,
    action: entry.action,
    version: entry.version || "",
    sourceUrl: entry.sourceUrl || "",
    installerSha256: entry.installerSha256 || "",
    // Only ever a provider id ("openrouter"|"ollama") and a model id/tag --
    // never the API key itself.
    provider: entry.provider || "",
    model: entry.model || "",
    changes: entry.changes || [],
    uninstall: officialUninstallSteps(entry.agentId)
  };
  current.push(record);
  await writeJson(receiptPath(), current);
  return record;
}
