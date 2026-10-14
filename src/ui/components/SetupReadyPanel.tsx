// The "Ready" step: a final look at what is in place. It is built from a FRESH
// check (refresh=1 on every load: a cached "it worked" would be stale the moment a
// job finishes) plus each always-on agent's live safety detail, and the append-only
// install receipt with the official uninstall steps. It is calm when all is well
// and plain about what is left when it is not: the headline never says "ready"
// over a problem.
import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { ArrowRight, ChevronDown, ChevronUp, CircleCheck, RefreshCw, TriangleAlert } from "lucide-react";
import Banner from "./Banner";
import SetupFooter from "./SetupFooter";
import SetupStatus from "./SetupStatus";
import { withTimeout } from "../homeShared";
import { gotNoAnswer, readyVerdict, safeDefaultsWords, type ReadyAgentState } from "../setupGroupShared";
import type { AgentDetail, BrainOptionsResponse, ReceiptEntry, SystemCheck } from "../../setupApi";
import { getAgentDetail, getBrainOptions, getReceipt, getSetupCheck } from "../../setupApi";

const COLUMNS = "minmax(132px, 240px) minmax(0, 1fr) minmax(176px, auto)";

// The fresh check re-probes every agent, which can take about 13 s on a cold or hung command.
const CHECK_TIMEOUT_MS = 25000;
const READ_TIMEOUT_MS = 20000;

const AGENT_LABEL: Record<string, string> = {
  hermes: "Hermes",
  openclaw: "OpenClaw",
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor CLI",
  "managed-node": "Node 24 (managed by Agent OS)"
};

interface ReadyRow {
  name: string;
  detail: ReactNode;
  // true = in place, false = needs attention, null = not known (shown as "—").
  state: boolean | null;
  fixLabel?: string;
  onFix?: () => void;
}

interface ReadyCard {
  agentId: "hermes" | "openclaw";
  unsupported: boolean;
  rows: ReadyRow[];
}

// One card per always-on agent. What is wrong, and what is not known, is counted by readyVerdict
// (setupGroupShared.ts, tested in test/setup-page-logic.test.js), so the heading never says
// "ready" over a red row or over a dash; this only draws the rows.
function buildCards(
  check: SystemCheck,
  brain: BrainOptionsResponse | null,
  details: Record<string, AgentDetail | null>,
  states: ReadyAgentState[],
  go: { toStep: (index: number) => void; openAgent: (agentId: string) => void }
): ReadyCard[] {
  return states.map((state) => {
    const { agentId, unsupported, fact, installed, configured, serviceRunning, safeDefaults } = state;
    const entry = check.agents?.[agentId];
    const detail = details[agentId];
    const rows: ReadyRow[] = [
      {
        name: "Installed",
        detail: installed ? <span className="os-mono">{entry?.detected.version || "Version not reported"}</span> : "—",
        state: fact !== "unknown" ? installed : null,
        fixLabel: "Go to Plan",
        onFix: () => go.toStep(1)
      },
      {
        name: "Model provider configured",
        detail: installed ? brain?.current?.[agentId]?.summary || "—" : "—",
        state: installed ? configured : null,
        fixLabel: "Go to AI brain",
        onFix: () => go.toStep(3)
      },
      {
        name: agentId === "openclaw" ? "Gateway running" : "Background service running",
        detail: installed ? (entry?.service ? (entry.service.running ? "Running" : "Stopped") : "—") : "—",
        state: installed ? serviceRunning : null,
        fixLabel: "Go to AI brain",
        onFix: () => go.toStep(3)
      },
      {
        name: "Safe defaults applied",
        detail: safeDefaultsWords(installed, detail),
        state: safeDefaults,
        fixLabel: "Change on the Agents page",
        onFix: () => go.openAgent(agentId)
      }
    ];
    return { agentId, unsupported, rows };
  });
}

// A receipt time that cannot be read is "—", never "Invalid Date".
function receiptTime(at: string) {
  const when = new Date(at);
  return Number.isNaN(when.getTime()) ? "—" : when.toLocaleString();
}

export default function SetupReadyPanel({
  onGoHome,
  onOpenSafety,
  onGoToStep,
  onOpenAgent,
  onProblems
}: {
  onGoHome: () => void;
  onOpenSafety: () => void;
  onGoToStep: (index: number) => void;
  onOpenAgent: (agentId: string) => void;
  // How many things are left to fix (null while unknown), so the step rail can show Ready as done only when it is.
  onProblems?: (problems: number | null) => void;
}) {
  const [check, setCheck] = useState<SystemCheck | null>(null);
  const [brain, setBrain] = useState<BrainOptionsResponse | null>(null);
  const [receipt, setReceipt] = useState<ReceiptEntry[] | null>(null);
  const [details, setDetails] = useState<Record<string, AgentDetail | null>>({});
  const [loading, setLoading] = useState(true);
  const [showReceipt, setShowReceipt] = useState(false);
  // Why the last load failed ("" = it worked). After one good load the data stays on screen under a note.
  const [problem, setProblem] = useState("");
  const receiptId = useId();
  const alive = useRef(true);

  async function load() {
    setLoading(true);
    try {
      const [checkRes, brainRes, receiptRes, hermesDetail, openclawDetail] = await Promise.all([
        withTimeout(getSetupCheck(true), CHECK_TIMEOUT_MS),
        withTimeout(getBrainOptions(true), READ_TIMEOUT_MS),
        withTimeout(getReceipt(), READ_TIMEOUT_MS),
        withTimeout(getAgentDetail("hermes"), READ_TIMEOUT_MS).catch(() => null),
        withTimeout(getAgentDetail("openclaw"), READ_TIMEOUT_MS).catch(() => null)
      ]);
      if (!alive.current) return;
      setCheck(checkRes);
      setBrain(brainRes);
      setReceipt(receiptRes.receipt);
      setDetails({ hermes: hermesDetail, openclaw: openclawDetail });
      setProblem("");
    } catch (error) {
      if (!alive.current) return;
      setProblem(gotNoAnswer(error) ? "Agent OS did not answer in time." : "Agent OS could not finish the final check.");
    } finally {
      if (alive.current) setLoading(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Data kept from an earlier load (a later load failed), a partial answer, or a row that could not be
  // read is "unsure": not a count to put on the rail, and never "ready".
  const verdict = check ? readyVerdict(check, brain, details, Boolean(problem)) : null;
  const built = check && verdict ? buildCards(check, brain, details, verdict.agents, { toStep: onGoToStep, openAgent: onOpenAgent }) : null;
  const problems = verdict ? verdict.railCount : null;
  useEffect(() => {
    onProblems?.(problems);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problems]);

  // Uninstall steps grouped by what they remove, each from the receipt data.
  const uninstallByAgent = new Map<string, string[]>();
  for (const entry of receipt || []) {
    const steps = uninstallByAgent.get(entry.agentId) || [];
    for (const step of entry.uninstall) if (!steps.includes(step)) steps.push(step);
    uninstallByAgent.set(entry.agentId, steps);
  }

  if (!built || !verdict) {
    if (loading) {
      return (
        <>
          <div className="os-setup-panel__content">
            <p className="os-setup-loading" role="status">
              Checking this computer…
            </p>
          </div>
          <SetupFooter note="Reading what is in place." />
        </>
      );
    }
    return (
      <>
        <div className="os-setup-panel__content">
          <Banner
            tone="danger"
            title="Couldn't load the final check"
            actions={
              <button type="button" className="os-btn os-btn--secondary" onClick={() => void load()}>
                <RefreshCw size={14} aria-hidden="true" /> Retry
              </button>
            }
          >
            {problem || "Agent OS could not finish the final check."} Try again, or open Agents to see each agent on its own.
          </Banner>
        </div>
        <SetupFooter note="The final check did not finish." />
      </>
    );
  }

  const { ready, partial, problems: left } = verdict;
  return (
    <>
      <div className="os-setup-panel__content">
        {problem ? (
          <Banner
            tone="warn"
            title="Couldn't re-check just now"
            actions={
              <button type="button" className="os-btn os-btn--secondary" onClick={() => void load()} disabled={loading}>
                <RefreshCw size={14} aria-hidden="true" /> Retry
              </button>
            }
          >
            {problem} What you see is from the last check, so it may be out of date.
          </Banner>
        ) : partial ? (
          <Banner tone="warn" title="Part of the final check did not finish">
            Rows marked — could not be read this time. Press Check again.
          </Banner>
        ) : null}

        <div className="os-setup-done">
          {ready ? (
            <CircleCheck className="os-setup-done__icon os-setup-done__icon--ok" size={30} aria-hidden="true" />
          ) : (
            <TriangleAlert className="os-setup-done__icon os-setup-done__icon--warn" size={30} aria-hidden="true" />
          )}
          <div>
            <b>
              {problem
                ? `Last check: ${left} thing${left === 1 ? "" : "s"} left to fix`
                : partial
                  ? "Can't tell yet if everything is in place"
                  : ready
                    ? "Agent OS is ready"
                    : `Almost ready: ${left} thing${left === 1 ? "" : "s"} left to fix`}
            </b>
            <span>
              {problem
                ? "This is from the last check that worked."
                : partial
                  ? "Press Check again."
                  : ready
                    ? "Everything below is in place."
                    : "Fix the items marked below, then check again."}
            </span>
          </div>
          <button type="button" className="os-btn os-btn--ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={16} aria-hidden="true" />
            {loading ? "Checking…" : "Check again"}
          </button>
        </div>

        <div className="os-table os-setup-table" role="table" aria-label="What is ready" style={{ "--os-table-cols": COLUMNS } as CSSProperties}>
          <div className="os-table__head" role="row">
            {["Item", "What Agent OS found", "Result"].map((heading) => (
              <span key={heading} className="os-table__cell os-micro" role="columnheader">
                {heading}
              </span>
            ))}
          </div>
          {built.map((card) => (
            <div key={card.agentId} role="rowgroup">
              <div className="os-table__group os-setup-table__group" role="presentation">
                <b>{AGENT_LABEL[card.agentId]}</b>
              </div>
              {card.unsupported ? (
                <div className="os-table__row" role="row">
                  <div className="os-table__cell os-setup-table__name" role="rowheader">
                    Support
                  </div>
                  <div className="os-table__cell os-setup-table__detail" role="cell">
                    Hermes doesn't support Intel Macs yet, so it isn't set up here.
                  </div>
                  <div className="os-table__cell" role="cell">
                    <SetupStatus tone="unknown">Not supported</SetupStatus>
                  </div>
                </div>
              ) : (
                card.rows.map((row) => (
                  <div key={row.name} className="os-table__row" role="row">
                    <div className="os-table__cell os-setup-table__name" role="rowheader">
                      {row.name}
                    </div>
                    <div className="os-table__cell os-setup-table__detail" role="cell">
                      {row.detail}
                    </div>
                    <div className="os-table__cell os-setup-ready__result" role="cell">
                      {row.state === true ? (
                        <SetupStatus tone="ok">Done</SetupStatus>
                      ) : row.state === false ? (
                        <>
                          <SetupStatus tone="error">Needs attention</SetupStatus>
                          {row.onFix ? (
                            <button type="button" className="os-btn os-btn--secondary" onClick={row.onFix}>
                              {row.fixLabel || "Fix"}
                            </button>
                          ) : null}
                        </>
                      ) : (
                        <SetupStatus tone="unknown">—</SetupStatus>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          ))}
        </div>

        <div className="os-setup-receipt">
          <button
            type="button"
            className="os-btn os-btn--ghost"
            onClick={() => setShowReceipt((v) => !v)}
            aria-expanded={showReceipt}
            aria-controls={receiptId}
          >
            {showReceipt ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
            What Setup changed on this computer
          </button>
          {showReceipt ? (
            <div id={receiptId} className="os-setup-receipt__body">
              <p className="os-setup-receipt__cap">Every change Agent OS made is listed here, with the official way to undo it.</p>
              {receipt && receipt.length ? (
                <ul className="os-setup-receipt__list">
                  {receipt.map((entry, i) => (
                    <li key={i}>
                      <span className="os-mono">{receiptTime(entry.at)}</span>
                      <span>
                        {AGENT_LABEL[entry.agentId] || entry.agentId} · {entry.action}
                        {entry.version ? ` (${entry.version})` : ""}
                      </span>
                      {entry.changes.length ? (
                        <ul className="os-setup-receipt__changes">
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
                <p className="os-setup-receipt__empty">Nothing installed or changed by Agent OS yet.</p>
              )}
              {uninstallByAgent.size ? (
                <>
                  <h4>How to remove each item</h4>
                  {Array.from(uninstallByAgent.entries()).map(([agentId, steps]) => (
                    <div key={agentId} className="os-setup-receipt__group">
                      <b>{AGENT_LABEL[agentId] || agentId}</b>
                      <ul>
                        {steps.map((step, i) => (
                          <li key={i} className="os-mono">
                            {step}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <SetupFooter note={ready ? "Setup keeps what works and asks before it changes anything." : "Fix the items marked above, then check again."}>
        <button type="button" className="os-btn os-btn--ghost" onClick={() => onGoToStep(0)}>
          <RefreshCw size={16} aria-hidden="true" />
          Run Setup again
        </button>
        <button type="button" className="os-btn os-btn--secondary" onClick={onOpenSafety}>
          Open Safety
        </button>
        <button type="button" className="os-btn os-btn--primary" onClick={onGoHome}>
          Go to Home
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </SetupFooter>
    </>
  );
}
