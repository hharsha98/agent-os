// The "Check" step's row list: one row per real probe from GET
// /api/setup/check, each with a status mark and a one-line plain meaning.
// Rows render as they arrive together (no fake staggered progress).
import StatusMark, { type StatusKind } from "./StatusMark";
import type { SystemCheck } from "../../setupApi";

function Row({ mark, label, detail }: { mark: StatusKind; label: string; detail: string }) {
  return (
    <li className="os-setup-check__row">
      <StatusMark kind={mark} />
      <span className="os-setup-check__label">{label}</span>
      <span className="os-setup-check__detail">{detail}</span>
    </li>
  );
}

function gb(n: number | null | undefined) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)} GB`;
}

export default function SetupCheckList({ check }: { check: SystemCheck }) {
  const tools = check.tools;
  const isMac = check.os === "darwin";
  const network = check.network || [];
  const networkOk = network.length ? network.filter((n) => n.ok).length : 0;
  const hermes = check.agents?.hermes;
  const openclaw = check.agents?.openclaw;
  const ollama = check.ollama;

  return (
    <ul className="os-setup-check">
      <Row
        mark="ok"
        label="Operating system"
        detail={`${isMac ? "macOS" : check.os === "win32" ? "Windows" : "Linux"}${check.osVersion ? ` ${check.osVersion}` : ""} · ${check.arch}`}
      />
      {isMac && check.isIntelMac ? (
        <Row mark="warn" label="Chip" detail="Intel Mac — Hermes doesn't support Intel Macs yet; we'll set up OpenClaw only." />
      ) : null}
      <Row mark={typeof check.ramGb === "number" ? "ok" : "unknown"} label="Memory" detail={typeof check.ramGb === "number" ? `${check.ramGb.toFixed(1)} GB total` : "—"} />
      <Row mark={typeof check.freeDiskGb === "number" ? "ok" : "unknown"} label="Free disk space" detail={gb(check.freeDiskGb)} />
      <Row
        mark={tools?.git?.found ? "ok" : "unknown"}
        label="Git"
        detail={tools?.git?.found ? tools.git.version || "installed" : "Not found; may be installed automatically"}
      />
      <Row
        /* An older system Node isn't a problem (Setup gives OpenClaw its own
           newer copy), so it gets the neutral mark, not a green "all good". */
        mark={tools?.node?.found && tools.node.nodeOkForOpenClaw ? "ok" : "unknown"}
        label="Node"
        detail={
          tools?.node?.found
            ? `${tools.node.version || "installed"}${tools.node.nodeOkForOpenClaw ? "" : " · older than OpenClaw needs, so Setup gives OpenClaw its own copy"}`
            : "Not found; a managed Node will be downloaded if needed"
        }
      />
      <Row
        mark={tools?.python3?.found || tools?.uv?.found ? "ok" : "unknown"}
        label="Python / uv"
        detail={
          tools?.uv?.found
            ? `uv ${tools.uv.version || "installed"}`
            : tools?.python3?.found
              ? `python3 ${tools.python3.version || "installed"}`
              : "Not found"
        }
      />
      <Row
        mark={tools?.docker?.found ? (tools.docker.running ? "ok" : "warn") : "unknown"}
        label="Docker"
        detail={tools?.docker?.found ? (tools.docker.running ? "installed, running" : "installed, not running") : "Not found (optional)"}
      />
      <Row
        mark={network.length ? (networkOk === network.length ? "ok" : networkOk > 0 ? "warn" : "error") : "unknown"}
        label="Internet reachability"
        detail={
          network.length
            ? `${networkOk}/${network.length} install hosts reachable${
                networkOk < network.length
                  ? ` · can't reach ${network.filter((n) => !n.ok).map((n) => n.host).join(", ")}; check your internet connection`
                  : ""
              }`
            : "—"
        }
      />
      <Row
        mark={hermes?.detected.installed ? "ok" : "unknown"}
        label="Hermes"
        detail={
          hermes?.detected.installed
            ? `${hermes.detected.version || "installed"}${hermes.service ? ` · ${hermes.service.running ? "gateway running" : "gateway stopped"}` : ""}`
            : "Not installed"
        }
      />
      <Row
        mark={openclaw?.detected.installed ? "ok" : "unknown"}
        label="OpenClaw"
        detail={
          openclaw?.detected.installed
            ? `${openclaw.detected.version || "installed"}${openclaw.service ? ` · ${openclaw.service.running ? "gateway running" : "gateway stopped"}` : ""}`
            : "Not installed"
        }
      />
      <Row mark={ollama?.found ? "ok" : "unknown"} label="Ollama" detail={ollama?.found ? ollama.version || "installed" : "Not installed"} />
    </ul>
  );
}
