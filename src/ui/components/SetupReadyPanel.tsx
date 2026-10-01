// The "Ready" step: a green/red checklist per agent built from a FRESH
// check (refresh=1 on every load -- a cached "it worked" would be stale the
// moment a job finishes) plus each agent's live safety detail, and the
// append-only install receipt with the official uninstall steps.
import { useEffect, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import StatusMark from "./StatusMark";
import type { AgentDetail, BrainOptionsResponse, ReceiptEntry, SystemCheck } from "../../setupApi";
import { getAgentDetail, getBrainOptions, getReceipt, getSetupCheck } from "../../setupApi";

const AGENT_LABEL: Record<string, string> = { hermes: "Hermes", openclaw: "OpenClaw", "managed-node": "Node 24 (managed by Agent OS)" };

function ChecklistRow({ ok, label, fixLabel, onFix }: { ok: boolean | null; label: string; fixLabel?: string; onFix?: () => void }) {
  return (
    <li className="os-setup-ready__row">
      <StatusMark kind={ok === null ? "unknown" : ok ? "ok" : "error"} />
      <span>{label}</span>
      {ok === false && onFix ? (
        <button type="button" className="os-btn os-btn--ghost" onClick={onFix}>
          {fixLabel || "Fix"}
        </button>
      ) : null}
    </li>
  );
}

export default function SetupReadyPanel({
  onGoHome,
  onOpenSafety,
  onGoToStep,
  onOpenAgent
}: {
  onGoHome: () => void;
  onOpenSafety: () => void;
  onGoToStep: (index: number) => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const [check, setCheck] = useState<SystemCheck | null>(null);
  const [brain, setBrain] = useState<BrainOptionsResponse | null>(null);
  const [receipt, setReceipt] = useState<ReceiptEntry[] | null>(null);
  const [details, setDetails] = useState<Record<string, AgentDetail | null>>({});
  const [loading, setLoading] = useState(true);
  const [showUninstall, setShowUninstall] = useState(false);
  const [error, setError] = useState(false);

  async function load() {
    setLoading(true);
    setError(false);
    try {
      const [checkRes, brainRes, receiptRes, hermesDetail, openclawDetail] = await Promise.all([
        getSetupCheck(true),
        getBrainOptions(true),
        getReceipt(),
        getAgentDetail("hermes").catch(() => null),
        getAgentDetail("openclaw").catch(() => null)
      ]);
      setCheck(checkRes);
      setBrain(brainRes);
      setReceipt(receiptRes.receipt);
      setDetails({ hermes: hermesDetail, openclaw: openclawDetail });
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading && !check) {
    return <p className="os-setup__loading">Checking your computer…</p>;
  }
  if (error || !check) {
    return (
      <div className="os-setup__error">
        <p>Couldn't load the Ready checklist.</p>
        <button type="button" className="os-btn os-btn--secondary" onClick={() => void load()}>
          <RefreshCw size={14} /> Retry
        </button>
      </div>
    );
  }

  // Count what is actually wrong, so the heading never says "ready" over red rows.
  let problems = 0;
  const cards = (["hermes", "openclaw"] as const).map((agentId) => {
    const entry = check.agents?.[agentId];
    const unsupported = agentId === "hermes" && Boolean(check.isIntelMac);
    const installed = Boolean(entry?.detected.installed);
    const configured = brain?.current?.[agentId]?.configured ?? null;
    const serviceRunning = installed ? Boolean(entry?.service?.running) : null;
    const detail = details[agentId];
    const safeDefaults = installed ? (detail ? !detail.safety.permissive : null) : null;
    if (!unsupported) {
      if (!installed) problems += 1;
      else problems += [configured, serviceRunning, safeDefaults].filter((v) => v === false).length;
    }
    return { agentId, unsupported, installed, configured, serviceRunning, safeDefaults };
  });

  // Uninstall steps grouped by what they remove, each from the receipt data.
  const uninstallByAgent = new Map<string, string[]>();
  for (const entry of receipt || []) {
    const steps = uninstallByAgent.get(entry.agentId) || [];
    for (const step of entry.uninstall) if (!steps.includes(step)) steps.push(step);
    uninstallByAgent.set(entry.agentId, steps);
  }

  return (
    <div className="os-setup-ready">
      <div className="os-setup-ready__head">
        <h2>{problems === 0 ? "Agent OS is ready" : `Almost ready: ${problems} thing${problems === 1 ? "" : "s"} left to fix`}</h2>
        <button type="button" className="os-btn os-btn--secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={14} /> Run the check again
        </button>
      </div>

      {cards.map(({ agentId, unsupported, installed, configured, serviceRunning, safeDefaults }) => (
        <div className="os-panel os-setup-ready__card" key={agentId}>
          <strong>{AGENT_LABEL[agentId]}</strong>
          {unsupported ? (
            <p className="os-setup-ready__empty">Hermes doesn't support Intel Macs yet, so it isn't set up here.</p>
          ) : (
            <ul>
              <ChecklistRow ok={installed} label="Installed" fixLabel="Go to Plan" onFix={() => onGoToStep(1)} />
              <ChecklistRow
                ok={installed ? configured : null}
                label="Model provider configured"
                fixLabel="Go to AI brain"
                onFix={() => onGoToStep(3)}
              />
              <ChecklistRow
                ok={installed ? serviceRunning : null}
                label="Background service running"
                fixLabel="Go to AI brain"
                onFix={() => onGoToStep(3)}
              />
              <ChecklistRow
                ok={safeDefaults}
                label="Safe defaults applied"
                fixLabel="Change on the Agents page"
                onFix={() => onOpenAgent(agentId)}
              />
            </ul>
          )}
        </div>
      ))}

      <div className="os-panel os-setup-ready__receipt">
        <header>
          <strong>Install receipt</strong>
        </header>
        {receipt && receipt.length ? (
          <ul className="os-setup-ready__receipt-list">
            {receipt.map((entry, i) => (
              <li key={i}>
                <span className="os-mono">{new Date(entry.at).toLocaleString()}</span>
                <span>
                  {AGENT_LABEL[entry.agentId] || entry.agentId} — {entry.action}
                  {entry.version ? ` (${entry.version})` : ""}
                </span>
                {entry.changes.length ? (
                  <ul className="os-setup-ready__receipt-changes">
                    {/* recipes.js already writes these with a literal "~", e.g.
                        "Creates ~/.hermes..." -- never an absolute home path. */}
                    {entry.changes.map((c, j) => (
                      <li key={j}>{c}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="os-setup-ready__empty">Nothing installed or changed by Agent OS yet.</p>
        )}
        {uninstallByAgent.size ? (
          <div className="os-setup-plan-card__disclosure">
            <button
              type="button"
              className="os-btn os-btn--ghost"
              onClick={() => setShowUninstall((v) => !v)}
              aria-expanded={showUninstall}
            >
              <ChevronDown size={14} style={{ transform: showUninstall ? "rotate(180deg)" : undefined }} /> How to remove each item
            </button>
            {showUninstall
              ? Array.from(uninstallByAgent.entries()).map(([agentId, steps]) => (
                  <div key={agentId} className="os-setup-ready__uninstall-group">
                    <strong>{AGENT_LABEL[agentId] || agentId}</strong>
                    <ul className="os-setup-ready__uninstall">
                      {steps.map((step, i) => (
                        <li key={i} className="os-mono">
                          {step}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              : null}
          </div>
        ) : null}
      </div>

      <div className="os-setup-ready__actions">
        <button type="button" className="os-btn os-btn--secondary" onClick={onGoHome}>
          Go to Home
        </button>
        <button type="button" className="os-btn os-btn--primary" onClick={onOpenSafety}>
          Open Safety
        </button>
      </div>
    </div>
  );
}
