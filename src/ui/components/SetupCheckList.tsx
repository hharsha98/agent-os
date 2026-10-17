// The "Check" step's table: one row per real probe from GET /api/setup/check,
// then one row per agent. Each result is an icon plus a word. Rows appear
// together (no staggered fake progress). A value the check did not report is "—",
// never "Not found": when part of the check fails, the server still answers, with
// fewer fields and an `error` line, and the page must not read a missing field as
// "nothing is installed".
import type { CSSProperties, ReactNode } from "react";
import Banner from "./Banner";
import SetupStatus, { type SetupTone } from "./SetupStatus";
import { AGENT_NAMES, agentFact } from "../setupGroupShared";
import type { SystemCheck } from "../../setupApi";

const COLUMNS = "minmax(132px, 176px) minmax(0, 1fr) 176px";
const AGENT_IDS = ["hermes", "openclaw", "claude", "codex", "cursor"] as const;
// Hermes calls it a background service, OpenClaw a Gateway.
const SERVICE_WORD: Record<string, string> = { hermes: "background service", openclaw: "Gateway" };

interface RowDef {
  name: string;
  detail: ReactNode;
  tone: SetupTone;
  word: string;
}

const unknownRow = (name: string): RowDef => ({ name, detail: "—", tone: "unknown", word: "—" });

function gb(n: number | null | undefined) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)} GB`;
}

function computerRows(check: SystemCheck): RowDef[] {
  const tools = check.tools;
  const isMac = check.os === "darwin";
  const platform = isMac ? "macOS" : check.os === "win32" ? "Windows" : "Linux";
  const network = check.network || [];
  const reachable = network.filter((n) => n.ok).length;
  const unreachable = network.filter((n) => !n.ok).map((n) => n.host);
  const rows: RowDef[] = [
    { name: "Operating system", detail: `${platform}${check.osVersion ? ` ${check.osVersion}` : ""} · ${check.arch}`, tone: "ok", word: "Found" }
  ];
  if (isMac && check.isIntelMac) {
    rows.push({
      name: "Chip",
      detail: "Intel Mac. Hermes does not support Intel Macs yet, so Setup sets up OpenClaw only.",
      tone: "warn",
      word: "Limited"
    });
  }
  rows.push(
    typeof check.ramGb === "number"
      ? { name: "Memory", detail: `${check.ramGb.toFixed(1)} GB total`, tone: "ok", word: "Found" }
      : unknownRow("Memory"),
    typeof check.freeDiskGb === "number"
      ? { name: "Free disk space", detail: gb(check.freeDiskGb), tone: "ok", word: "Found" }
      : unknownRow("Free disk space"),
    !tools
      ? unknownRow("Git")
      : tools.git?.found
        ? { name: "Git", detail: tools.git.version || "Installed", tone: "ok", word: "Found" }
        : { name: "Git", detail: "Not found. It may be installed automatically.", tone: "info", word: "Not found" }
  );
  // An older system Node is not a problem: Setup gives OpenClaw its own newer copy.
  if (!tools) {
    rows.push(unknownRow("Node"));
  } else if (tools.node?.found && tools.node.nodeOkForOpenClaw) {
    rows.push({ name: "Node", detail: tools.node.version || "Installed", tone: "ok", word: "Found" });
  } else if (tools.node?.found) {
    rows.push({
      name: "Node",
      detail: `${tools.node.version || "Installed"} · older than OpenClaw needs, so Setup gives OpenClaw its own copy`,
      tone: "info",
      word: "Handled by Setup"
    });
  } else {
    rows.push({ name: "Node", detail: "Not found. A managed Node is downloaded if needed.", tone: "info", word: "Handled by Setup" });
  }
  rows.push(
    !tools
      ? unknownRow("Python and uv")
      : tools.uv?.found || tools.python3?.found
        ? {
            name: "Python and uv",
            detail: tools.uv?.found ? `uv ${tools.uv.version || "installed"}` : `python3 ${tools.python3?.version || "installed"}`,
            tone: "ok",
            word: "Found"
          }
        : { name: "Python and uv", detail: "Not found.", tone: "info", word: "Not found" },
    !tools
      ? unknownRow("Docker")
      : tools.docker?.found
        ? tools.docker.running
          ? { name: "Docker", detail: "Installed, running", tone: "ok", word: "Found" }
          : { name: "Docker", detail: "Installed, not running", tone: "warn", word: "Not running" }
        : { name: "Docker", detail: "Not found. It is optional.", tone: "unknown", word: "Optional" }
  );
  if (!network.length) {
    rows.push(unknownRow("Internet reachability"));
  } else if (reachable === network.length) {
    rows.push({ name: "Internet reachability", detail: `All ${network.length} install sites can be reached`, tone: "ok", word: "Reachable" });
  } else if (reachable > 0) {
    rows.push({
      name: "Internet reachability",
      detail: `${reachable} of ${network.length} install sites reachable. Can't reach ${unreachable.join(", ")}. Check your internet connection.`,
      tone: "warn",
      word: "Partly reachable"
    });
  } else {
    rows.push({
      name: "Internet reachability",
      detail: "Can't reach any install site. Check your internet connection.",
      tone: "error",
      word: "Not reachable"
    });
  }
  rows.push(
    !check.ollama
      ? unknownRow("Ollama")
      : check.ollama.found
        ? { name: "Ollama", detail: check.ollama.version || "Installed", tone: "ok", word: "Found" }
        : { name: "Ollama", detail: "Not installed. Only needed for a Local brain.", tone: "unknown", word: "Not installed" }
  );
  return rows;
}

function agentRows(check: SystemCheck): RowDef[] {
  return AGENT_IDS.map((id): RowDef => {
    const entry = check.agents?.[id];
    // The check did not report this agent at all: that is not "not installed".
    if (!entry?.detected || typeof entry.detected.installed !== "boolean") return unknownRow(AGENT_NAMES[id]);
    // A program that is simply not on the computer ("claude was not found on PATH.") is "Not installed".
    // "Can't tell" is only for a detection that itself broke (any other error).
    const fact = agentFact(entry.detected);
    if (fact === "unknown") {
      return { name: AGENT_NAMES[id], detail: "Agent OS could not tell whether it is installed.", tone: "warn", word: "Can't tell" };
    }
    const installed = fact === "installed";
    const service = installed && entry.service && SERVICE_WORD[id] ? ` · ${SERVICE_WORD[id]} ${entry.service.running ? "running" : "stopped"}` : "";
    return {
      name: AGENT_NAMES[id],
      detail: installed ? (
        <>
          <span className="os-mono">{entry.detected.version || "Version not reported"}</span>
          {service}
        </>
      ) : (
        "—"
      ),
      tone: installed ? "ok" : "unknown",
      word: installed ? "Installed" : "Not installed"
    };
  });
}

function Row({ name, detail, tone, word }: RowDef) {
  return (
    <div className="os-table__row" role="row">
      <div className="os-table__cell os-setup-table__name" role="rowheader">
        {name}
      </div>
      <div className="os-table__cell os-setup-table__detail" role="cell">
        {detail}
      </div>
      <div className="os-table__cell" role="cell">
        <SetupStatus tone={tone}>{word}</SetupStatus>
      </div>
    </div>
  );
}

export default function SetupCheckList({ check }: { check: SystemCheck }) {
  return (
    <>
      {check.error ? (
        <Banner tone="warn" title="Part of the check did not finish">
          Rows marked — could not be read this time. Press Check again.
        </Banner>
      ) : null}
      <div
        className="os-table os-setup-table"
        role="table"
        aria-label="What Agent OS found on this computer"
        style={{ "--os-table-cols": COLUMNS } as CSSProperties}
      >
        <div className="os-table__head" role="row">
          {["This computer", "What Agent OS found", "Result"].map((heading) => (
            <span key={heading} className="os-table__cell os-micro" role="columnheader">
              {heading}
            </span>
          ))}
        </div>
        {computerRows(check).map((row) => (
          <Row key={row.name} {...row} />
        ))}
        <div className="os-table__group os-setup-table__group" role="presentation">
          <b>Agents</b>
          <span>Found on this computer</span>
        </div>
        {agentRows(check).map((row) => (
          <Row key={row.name} {...row} />
        ))}
      </div>
    </>
  );
}
