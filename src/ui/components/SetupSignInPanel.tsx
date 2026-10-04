// The "Sign in" step: one row per coding agent (Claude Code, Codex, Cursor) with
// a status mark, one button, and what the sign-in costs. The button runs the
// agent's OWN login command on the server, which opens the browser; the status
// comes from asking the agent itself. No password or token ever reaches this
// page -- it only sees "signed in", "not signed in" or "can't tell".
import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import Panel from "./Panel";
import RelativeTime from "./RelativeTime";
import StatusMark, { type StatusKind } from "./StatusMark";
import { useInterval } from "./useInterval";
import type { SignInAgentId, SignInInfo, SignInRun } from "../../setupApi";
import { cancelSignInRun, friendlyError, getSignIn, openSignInTerminal, startSignInRun } from "../../setupApi";

const AGENTS: { id: SignInAgentId; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor CLI" }
];

type Visual = "checking" | "not_installed" | "signed_in" | "not_signed_in" | "unknown" | "running" | "failed";

interface RowState {
  info: SignInInfo | null;
  error: string;
  busy: boolean;
  // What "sign in from a terminal window" did: opened it, or hands back the command.
  terminal: { opened: boolean; command: string } | null;
  copied: boolean;
}

const EMPTY: RowState = { info: null, error: "", busy: false, terminal: null, copied: false };

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

const MARK: Record<Visual, StatusKind> = {
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
  signed_in: "✓ Signed in",
  not_signed_in: "Not signed in",
  unknown: "Can't tell",
  failed: "Sign-in didn't finish"
};

export default function SetupSignInPanel({ onContinue, onGoToPlan }: { onContinue: () => void; onGoToPlan: () => void }) {
  const [rows, setRows] = useState<Record<SignInAgentId, RowState>>({ claude: EMPTY, codex: EMPTY, cursor: EMPTY });
  const [loading, setLoading] = useState(true);
  const latest = useRef(rows);
  latest.current = rows;

  function patch(id: SignInAgentId, change: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...change } }));
  }

  async function refresh(id: SignInAgentId) {
    try {
      patch(id, { info: await getSignIn(id), error: "" });
    } catch (error) {
      patch(id, { error: friendlyError(error, "Couldn't check the sign-in.") });
    }
  }

  async function refreshAll() {
    setLoading(true);
    await Promise.all(AGENTS.map((a) => refresh(a.id)));
    setLoading(false);
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
      for (const { id } of AGENTS) {
        if (!isActive(latest.current[id].info?.run)) continue;
        try {
          const next = await getSignIn(id, { runOnly: true });
          if (isActive(next.run)) {
            setRows((prev) => ({
              ...prev,
              [id]: { ...prev[id], info: prev[id].info ? { ...prev[id].info!, run: next.run } : prev[id].info }
            }));
          } else {
            await refresh(id);
          }
        } catch {
          // a missed poll is fine; the next one tries again
        }
      }
    },
    anyRunning ? 1500 : null
  );

  async function onSignIn(id: SignInAgentId) {
    patch(id, { busy: true, error: "", terminal: null });
    try {
      await startSignInRun(id);
      await refresh(id);
    } catch (error) {
      patch(id, { error: friendlyError(error) });
    } finally {
      patch(id, { busy: false });
    }
  }

  async function onCancel(id: SignInAgentId) {
    patch(id, { busy: true });
    try {
      await cancelSignInRun(id);
      await refresh(id);
    } catch (error) {
      patch(id, { error: friendlyError(error) });
    } finally {
      patch(id, { busy: false });
    }
  }

  async function onTerminal(id: SignInAgentId) {
    patch(id, { busy: true, error: "" });
    try {
      const result = await openSignInTerminal(id);
      patch(id, { terminal: { opened: result.opened, command: result.command }, copied: false });
    } catch (error) {
      patch(id, { error: friendlyError(error) });
    } finally {
      patch(id, { busy: false });
    }
  }

  async function onCopy(id: SignInAgentId, command: string) {
    try {
      await navigator.clipboard.writeText(command);
      patch(id, { copied: true });
      setTimeout(() => patch(id, { copied: false }), 2000);
    } catch {
      // Clipboard access denied; the command is still on screen to select.
    }
  }

  const anySignedIn = AGENTS.some((a) => visualOf(rows[a.id]) === "signed_in");

  return (
    <Panel className="os-setup-signin">
      <div className="os-setup__step-head">
        <h2>Sign in to your coding agents</h2>
        <p>
          Each button opens your web browser, on the agent's own sign-in page. Agent OS never sees your password or token; it
          only asks each agent whether it is signed in.
        </p>
      </div>

      <ul className="os-setup-signin__rows">
        {AGENTS.map(({ id, label }) => {
          const row = rows[id];
          const visual = visualOf(row);
          const info = row.info;
          const run = info?.run;
          const busy = row.busy;
          const signInLabel = visual === "failed" ? "Try again" : visual === "signed_in" ? "Sign in again" : "Sign in";
          return (
            <li key={id} className={`os-setup-signin__row os-setup-signin__row--${visual}`}>
              <div className="os-setup-signin__who">
                <StatusMark kind={MARK[visual]} pulse={visual === "running"} />
                <strong>{label}</strong>
                <span className="os-setup-signin__state" role="status">
                  {visual === "running" ? (
                    <>
                      Waiting for you in the browser ·{" "}
                      {run?.startedAt ? <RelativeTime since={run.startedAt} live /> : "just started"}
                    </>
                  ) : (
                    STATE_TEXT[visual]
                  )}
                </span>
              </div>

              <div className="os-setup-signin__actions">
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
                    className={`os-btn ${visual === "signed_in" ? "os-btn--secondary" : "os-btn--primary"}`}
                    onClick={() => void onSignIn(id)}
                    disabled={busy}
                    aria-label={`${signInLabel} · ${label}`}
                  >
                    {signInLabel}
                  </button>
                )}
              </div>

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
                </div>
              ) : null}

              {visual !== "running" && (row.error || info?.note || run?.reason) ? (
                <p className={`os-setup-signin__note${visual === "failed" || row.error ? " os-setup-signin__note--bad" : ""}`}>
                  {row.error || (visual === "failed" ? run?.reason : null) || info?.note}
                  {!row.error && visual === "not_signed_in" && run?.status === "stopped" ? " You cancelled the last sign-in." : ""}
                  {!row.error && visual === "not_signed_in" && run?.status === "succeeded"
                    ? " The sign-in window finished, but it still says you're not signed in. Try again."
                    : ""}
                </p>
              ) : null}

              <p className="os-setup-signin__cost">{info?.cost || ""}</p>

              {info?.installed !== false && visual !== "checking" && visual !== "running" && visual !== "signed_in" ? (
                <div className="os-setup-signin__terminal">
                  <button type="button" className="os-btn os-btn--ghost" onClick={() => void onTerminal(id)} disabled={busy}>
                    {run?.needsTerminal
                      ? "Open Terminal with this command"
                      : info?.terminalOpener
                        ? "Sign in from a Terminal window instead"
                        : "Show the command to run yourself"}
                  </button>
                  {row.terminal ? (
                    <div className="os-setup-signin__command">
                      <p>
                        {row.terminal.opened
                          ? "Terminal opened with the sign-in command. Finish there, then press “Check again”."
                          : "Run this command in your own terminal, finish signing in, then press “Check again”."}
                      </p>
                      <pre className="os-mono os-setup-plan-card__commands">{row.terminal.command}</pre>
                      <button type="button" className="os-btn os-btn--secondary" onClick={() => void onCopy(id, row.terminal!.command)}>
                        <Copy size={14} /> {row.copied ? "Copied" : "Copy the command"}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="os-setup__actions">
        <button type="button" className="os-btn os-btn--primary" onClick={onContinue}>
          {anySignedIn ? "Continue" : "Skip for now"}
        </button>
        <button type="button" className="os-btn os-btn--secondary" onClick={() => void refreshAll()} disabled={loading || anyRunning}>
          {loading ? "Checking…" : "Check again"}
        </button>
      </div>
    </Panel>
  );
}
