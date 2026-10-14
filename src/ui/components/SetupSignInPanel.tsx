// The "Sign in" step: one row per coding agent (Claude Code, Codex, Cursor) with
// a status, one button, and what the sign-in costs. The button runs the
// agent's OWN login command on the server, which opens the browser; the status
// comes from asking the agent itself. No password or token ever reaches this
// page -- it only sees "signed in", "not signed in" or "can't tell".
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ArrowRight, Lock, RefreshCw } from "lucide-react";
import RelativeTime from "./RelativeTime";
import SetupCommand from "./SetupCommand";
import SetupFooter from "./SetupFooter";
import SetupStatus, { type SetupTone } from "./SetupStatus";
import { useInterval } from "./useInterval";
import { withTimeout } from "../homeShared";
import { gotNoAnswer } from "../setupGroupShared";
import type { SignInAgentId, SignInInfo, SignInRun } from "../../setupApi";
import { cancelSignInRun, friendlyError, getSignIn, openSignInTerminal, startSignInRun } from "../../setupApi";

const AGENTS: { id: SignInAgentId; label: string; maker: string }[] = [
  { id: "claude", label: "Claude Code", maker: "Anthropic" },
  { id: "codex", label: "Codex", maker: "OpenAI" },
  { id: "cursor", label: "Cursor CLI", maker: "Cursor" }
];

const COLUMNS = "minmax(132px, 176px) 210px minmax(0, 1fr)";

// Asking an agent whether it is signed in runs its own command, which can take a
// while on a cold start; an action is one quick request; a poll must not pile up.
const STATUS_TIMEOUT_MS = 25000;
const ACTION_TIMEOUT_MS = 20000;
const POLL_TIMEOUT_MS = 10000;

type Visual = "checking" | "not_installed" | "signed_in" | "not_signed_in" | "unknown" | "running" | "failed";

interface RowState {
  info: SignInInfo | null;
  error: string;
  busy: boolean;
  // What "sign in from a terminal window" did: opened it, or hands back the command.
  terminal: { opened: boolean; command: string } | null;
  // A poll of the open sign-in got no answer: the output shown may be out of date.
  stale: boolean;
}

const EMPTY: RowState = { info: null, error: "", busy: false, terminal: null, stale: false };

const isActive = (run: SignInRun | null | undefined) => run?.status === "running" || run?.status === "queued";

function visualOf(row: RowState): Visual {
  const info = row.info;
  if (!info) return row.error ? "unknown" : "checking";
  if (isActive(info.run)) return "running";
  // A login the person cancelled is not a failure: it falls back to what the agent says.
  if (info.run && info.run.status !== "succeeded" && info.run.status !== "stopped" && info.status !== "signed_in") return "failed";
  if (info.installed === false) return "not_installed";
  return info.status || "unknown";
}

const TONE: Record<Visual, SetupTone> = {
  checking: "unknown",
  not_installed: "unknown",
  signed_in: "ok",
  not_signed_in: "warn",
  unknown: "unknown",
  running: "live",
  failed: "error"
};

const STATE_TEXT: Record<Exclude<Visual, "running">, string> = {
  checking: "Checking…",
  not_installed: "Not installed yet",
  signed_in: "Signed in",
  not_signed_in: "Not signed in",
  unknown: "Can't tell",
  failed: "Sign-in didn't finish"
};

export default function SetupSignInPanel({
  onContinue,
  onGoToPlan,
  onBack,
  onSummary
}: {
  onContinue: () => void;
  onGoToPlan: () => void;
  onBack?: () => void;
  // Reported when the first check has finished and whenever the counts change, so the
  // step rail can say "Done · 2 of 3 signed in". `unchecked` = agents whose check got no answer.
  onSummary?: (summary: { signedIn: number; installed: number; unchecked: number }) => void;
}) {
  const [rows, setRows] = useState<Record<SignInAgentId, RowState>>({ claude: EMPTY, codex: EMPTY, cursor: EMPTY });
  const [loading, setLoading] = useState(true);
  const latest = useRef(rows);
  latest.current = rows;
  // Answers that arrive after the person left this step are dropped, not drawn.
  const alive = useRef(true);
  const polling = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  function patch(id: SignInAgentId, change: Partial<RowState>) {
    if (!alive.current) return;
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...change } }));
  }

  async function refresh(id: SignInAgentId) {
    try {
      const info = await withTimeout(getSignIn(id), STATUS_TIMEOUT_MS);
      patch(id, { info, error: "", stale: false });
    } catch (error) {
      // The last good answer (if any) stays on screen; the note says it is the last one.
      const kept = Boolean(latest.current[id].info);
      patch(id, {
        error: gotNoAnswer(error)
          ? kept
            ? "Agent OS did not answer just now. What you see is from the last check."
            : "Agent OS did not answer, so this could not be checked. Press Check again."
          : friendlyError(error, "Couldn't check the sign-in.")
      });
    }
  }

  async function refreshAll() {
    setLoading(true);
    await Promise.all(AGENTS.map((a) => refresh(a.id)));
    if (alive.current) setLoading(false);
  }

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While a login is open only its run is polled (cheap); once it ends, the
  // agent is asked again whether it is signed in.
  const anyRunning = AGENTS.some((a) => isActive(rows[a.id].info?.run));
  useInterval(
    async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        for (const { id } of AGENTS) {
          if (!isActive(latest.current[id].info?.run)) continue;
          try {
            const next = await withTimeout(getSignIn(id, { runOnly: true }), POLL_TIMEOUT_MS);
            if (!alive.current) return;
            if (isActive(next.run)) {
              setRows((prev) => ({
                ...prev,
                [id]: { ...prev[id], stale: false, info: prev[id].info ? { ...prev[id].info!, run: next.run } : prev[id].info }
              }));
            } else {
              await refresh(id);
            }
          } catch {
            // The output on screen is the last good one; say so, and try again next tick.
            patch(id, { stale: true });
          }
        }
      } finally {
        polling.current = false;
      }
    },
    anyRunning ? 1500 : null
  );

  async function onSignIn(id: SignInAgentId) {
    patch(id, { busy: true, error: "", terminal: null });
    try {
      await withTimeout(startSignInRun(id), ACTION_TIMEOUT_MS);
      await refresh(id);
    } catch (error) {
      patch(id, {
        error: gotNoAnswer(error)
          ? "Agent OS did not answer, so the sign-in may or may not have started. Press Check again to see."
          : friendlyError(error)
      });
    } finally {
      patch(id, { busy: false });
    }
  }

  async function onCancel(id: SignInAgentId) {
    patch(id, { busy: true });
    try {
      await withTimeout(cancelSignInRun(id), ACTION_TIMEOUT_MS);
      await refresh(id);
    } catch (error) {
      patch(id, {
        error: gotNoAnswer(error)
          ? "Agent OS did not answer, so the cancel may not have gone through. The sign-in may still be open."
          : friendlyError(error)
      });
    } finally {
      patch(id, { busy: false });
    }
  }

  async function onTerminal(id: SignInAgentId) {
    patch(id, { busy: true, error: "" });
    try {
      const result = await withTimeout(openSignInTerminal(id), ACTION_TIMEOUT_MS);
      patch(id, { terminal: { opened: result.opened, command: result.command } });
    } catch (error) {
      patch(id, {
        error: gotNoAnswer(error)
          ? "Agent OS did not answer, so Terminal may or may not have opened. Try again."
          : friendlyError(error)
      });
    } finally {
      patch(id, { busy: false });
    }
  }

  const signedIn = AGENTS.filter((a) => visualOf(rows[a.id]) === "signed_in").length;
  const installed = AGENTS.filter((a) => rows[a.id].info && rows[a.id].info!.installed !== false).length;
  // An agent whose check got no answer is not "not installed" and not "not signed in": it is not known.
  const unchecked = AGENTS.filter((a) => !rows[a.id].info).length;
  const anySignedIn = signedIn > 0;

  useEffect(() => {
    if (!loading) onSummary?.({ signedIn, installed, unchecked });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, signedIn, installed, unchecked]);

  const counted =
    installed === 0
      ? unchecked > 0
        ? ""
        : "No coding agent is installed yet."
      : signedIn === installed && unchecked === 0
        ? "All are signed in."
        : `${signedIn} of ${installed} signed in.`;
  const note = loading
    ? "Checking each agent…"
    : [counted, unchecked > 0 ? `${unchecked} could not be checked. Press Check again.` : ""].filter(Boolean).join(" ");

  return (
    <>
      <div className="os-setup-panel__content">
        <div
          className="os-table os-setup-table os-setup-signin"
          role="table"
          aria-label="Coding agent sign-in"
          style={{ "--os-table-cols": COLUMNS } as CSSProperties}
        >
          <div className="os-table__head" role="row">
            {["Coding agent", "Status", "Sign in"].map((heading) => (
              <span key={heading} className={`os-table__cell os-micro${heading === "Sign in" ? " os-setup-table__right" : ""}`} role="columnheader">
                {heading}
              </span>
            ))}
          </div>

          {AGENTS.map(({ id, label, maker }) => {
            const row = rows[id];
            const visual = visualOf(row);
            const info = row.info;
            const run = info?.run;
            const busy = row.busy;
            const signInLabel = visual === "failed" ? "Try again" : visual === "signed_in" ? "Sign in again" : "Sign in";
            const canShowCommand = info?.installed !== false && visual !== "checking" && visual !== "running" && visual !== "signed_in";
            const commandLabel = run?.needsTerminal
              ? "Open Terminal with this command"
              : info?.terminalOpener
                ? "Sign in from a Terminal window instead"
                : "Show the command to run yourself";
            // A signed-in agent's own words ("Signed in with your Claude account.") sit under its status. The
            // plain "Signed in." adds nothing to the status, and the cost line is for people who still have to sign in.
            const noteUnderStatus = visual === "signed_in" && Boolean(info?.note) && info?.note !== "Signed in.";
            // An error from the person's own action (a Cancel that got no answer) must show while the sign-in is still open.
            const showNote = Boolean(row.error) || (visual !== "running" && visual !== "signed_in" && Boolean(info?.note || run?.reason));
            const showCost = Boolean(info?.cost) && visual !== "signed_in";
            const hasExtra = visual === "running" || showNote || showCost || Boolean(row.terminal);
            return (
              <div key={id} className="os-table__row os-setup-row" role="row">
                <div className="os-table__cell" role="rowheader">
                  <span className="os-setup-table__name">{label}</span>
                  <span className="os-setup-table__sub">{maker}</span>
                </div>

                <div className="os-table__cell" role="cell">
                  <span role="status">
                    <SetupStatus tone={TONE[visual]}>{visual === "running" ? "Waiting for you in the browser" : STATE_TEXT[visual]}</SetupStatus>
                  </span>
                  {visual === "running" ? (
                    <span className="os-setup-table__sub">{run?.startedAt ? <RelativeTime since={run.startedAt} live /> : "just started"}</span>
                  ) : noteUnderStatus ? (
                    <span className="os-setup-table__sub">{info?.note}</span>
                  ) : null}
                </div>

                <div className="os-table__cell os-setup-signin__actions" role="cell">
                  {visual === "not_installed" ? (
                    <button type="button" className="os-btn os-btn--secondary" onClick={onGoToPlan}>
                      Install it first
                    </button>
                  ) : visual === "running" ? (
                    <button type="button" className="os-btn os-btn--danger" onClick={() => void onCancel(id)} disabled={busy}>
                      Cancel
                    </button>
                  ) : visual === "checking" ? null : (
                    <button
                      type="button"
                      className={`os-btn ${visual === "signed_in" || anySignedIn ? "os-btn--secondary" : "os-btn--primary"}`}
                      onClick={() => void onSignIn(id)}
                      disabled={busy}
                      aria-label={`${signInLabel} · ${label}`}
                    >
                      {signInLabel}
                    </button>
                  )}
                  {canShowCommand ? (
                    <button type="button" className="os-btn os-btn--ghost" onClick={() => void onTerminal(id)} disabled={busy}>
                      {commandLabel}
                    </button>
                  ) : null}
                </div>

                {hasExtra ? (
                  <div className="os-setup-row__extra" role="cell">
                    {visual === "running" ? (
                      <div className="os-setup-signin__live">
                        <p>
                          Finish signing in on the page that just opened.{" "}
                          {run?.url ? (
                            <>
                              Nothing opened?{" "}
                              <a href={run.url} target="_blank" rel="noreferrer">
                                Open the sign-in page
                              </a>
                              .
                            </>
                          ) : (
                            "If nothing opens, a link will appear here in a few seconds."
                          )}
                        </p>
                        {run?.lines.length ? (
                          <div className="os-mono os-setup-signin__lines" role="log" aria-label={`${label} sign-in output`} tabIndex={0}>
                            {run.lines.map((line, i) => (
                              <div key={i}>{line}</div>
                            ))}
                          </div>
                        ) : null}
                        {row.stale ? (
                          <p className="os-setup-signin__note os-setup-signin__note--bad" role="status">
                            Agent OS did not answer just now, so the output above may be out of date. This page keeps trying.
                          </p>
                        ) : null}
                      </div>
                    ) : null}

                    {showNote ? (
                      <p className={`os-setup-signin__note${visual === "failed" || row.error ? " os-setup-signin__note--bad" : ""}`}>
                        {row.error || (visual === "failed" ? run?.reason : null) || info?.note}
                        {!row.error && visual === "not_signed_in" && run?.status === "stopped" ? " You cancelled the last sign-in." : ""}
                        {!row.error && visual === "not_signed_in" && run?.status === "succeeded"
                          ? " The sign-in window finished, but it still says you're not signed in. Try again."
                          : ""}
                      </p>
                    ) : null}

                    {showCost ? <p className="os-setup-signin__cost">{info?.cost}</p> : null}

                    {row.terminal ? (
                      <div className="os-setup-signin__command">
                        <p>
                          {row.terminal.opened
                            ? "Terminal opened with the sign-in command. Finish there, then press “Check again”."
                            : "Run this command in your own terminal, finish signing in, then press “Check again”."}
                        </p>
                        <SetupCommand command={row.terminal.command} label="Copy the command" />
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <p className="os-setup-safe">
          <Lock size={16} aria-hidden="true" />
          <span>
            Sign-in happens in each agent's own window or Terminal. Agent OS never sees your password or token; it only asks each agent
            whether it is signed in. Hermes and OpenClaw use the brain you chose, so they need no sign-in here.
          </span>
        </p>
      </div>

      <SetupFooter onBack={onBack} note={note}>
        <button type="button" className="os-btn os-btn--secondary" onClick={() => void refreshAll()} disabled={loading || anyRunning}>
          <RefreshCw size={16} aria-hidden="true" />
          {loading ? "Checking…" : "Check again"}
        </button>
        <button type="button" className={`os-btn ${anySignedIn ? "os-btn--primary" : "os-btn--secondary"}`} onClick={onContinue}>
          {anySignedIn ? "Continue" : "Skip for now"}
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </SetupFooter>
    </>
  );
}
