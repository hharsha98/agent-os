// "When a plan runs out": the one setting for what Agent OS does when Claude
// Code, Codex or Cursor stops because the person's PLAN hit its limit.
//   Ask me (the default)   a banner on the run offers the choices; nothing is spent
//                          unless a button is pressed.
//   Continue automatically carry on with OpenRouter by itself, but only when the
//                          cost of starting stays under the spending limit per run.
// The server enforces the rules (an automatic continue needs a limit, only Claude
// Code can be held to one, a key must be saved); this screen says them in words.
import { useEffect, useState } from "react";
import StatusMark from "./StatusMark";
import { useOpenRouterKey } from "./useBuilderBrains";
import type { BuilderBrains, OnLimit } from "../../buildersApi";
import { saveBuilderBrains } from "../../buildersApi";
import { explain, parseBudget } from "../builderShared";
import "../builders.css";

const DEFAULT_BUDGET = "5";

export default function PlanLimitSettings({ brains, onChanged }: { brains: BuilderBrains | null; onChanged: () => void | Promise<void> }) {
  const { status: key } = useOpenRouterKey();
  const [onLimit, setOnLimit] = useState<OnLimit>("ask");
  const [budgetText, setBudgetText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  // Follow what the server has saved (also after another screen changed it).
  const serverOnLimit = brains?.onLimit;
  const serverBudget = brains?.perRunBudgetUsd ?? null;
  useEffect(() => {
    if (!serverOnLimit) return;
    setOnLimit(serverOnLimit);
    setBudgetText(serverBudget === null ? "" : String(serverBudget));
  }, [serverOnLimit, serverBudget]);

  if (!brains) return null;

  const budget = parseBudget(budgetText);
  const dirty = onLimit !== brains.onLimit || (onLimit === "auto" && budget !== brains.perRunBudgetUsd);
  const problem = onLimit === "auto" && budget === null ? "Type the most you want one run to spend, for example 5." : "";

  function choose(next: OnLimit) {
    setOnLimit(next);
    setSaved(false);
    setError("");
    if (next === "auto" && !budgetText.trim()) setBudgetText(DEFAULT_BUDGET);
  }

  async function save() {
    if (problem || !dirty) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await saveBuilderBrains(onLimit === "auto" ? { onLimit, perRunBudgetUsd: budget } : { onLimit });
      setSaved(true);
      await onChanged();
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="os-panel os-bb-limit" aria-labelledby="os-bb-limit-title">
      <h2 id="os-bb-limit-title" className="os-bb-card__title">
        When a plan runs out
      </h2>
      <p className="os-bb-card__lead">
        If Claude Code, Codex or Cursor stops because the limit on your plan is used up, what should Agent OS do? This is one setting for all three.
      </p>

      <div className="os-bb-choices" role="radiogroup" aria-label="When a plan runs out">
        <label className={`os-bb-choice${onLimit === "ask" ? " os-bb-choice--on" : ""}`}>
          <input type="radio" name="os-bb-onlimit" checked={onLimit === "ask"} onChange={() => choose("ask")} />
          <span className="os-bb-choice__body">
            <strong>Ask me</strong>
            <span>The run shows a banner with your choices. Nothing is spent unless you press a button.</span>
          </span>
        </label>
        <label className={`os-bb-choice${onLimit === "auto" ? " os-bb-choice--on" : ""}`}>
          <input type="radio" name="os-bb-onlimit" checked={onLimit === "auto"} onChange={() => choose("auto")} />
          <span className="os-bb-choice__body">
            <span className="os-bb-choice__line">
              <strong>Continue on OpenRouter automatically, up to</strong>
              <span className="os-bb-money">
                <span aria-hidden="true">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="os-mono"
                  value={budgetText}
                  disabled={onLimit !== "auto" || busy}
                  onChange={(event) => {
                    setBudgetText(event.target.value);
                    setSaved(false);
                  }}
                  aria-label="Most one run may spend, in dollars"
                  size={5}
                  maxLength={7}
                />
              </span>
              <strong>per run</strong>
            </span>
            <span>
              Only Claude Code can be held to a spending limit, so for Codex and Cursor Agent OS still asks first. It also asks whenever the estimate is
              over your limit.
            </span>
          </span>
        </label>
      </div>

      {onLimit === "auto" && key !== null && !key.stored ? (
        <p className="os-mp-hint os-mp-hint--warn">
          <StatusMark kind="warn" label="note" /> Continuing automatically needs your OpenRouter key saved. Add it on Claude Code&apos;s Brain card (OpenRouter).
        </p>
      ) : null}
      {problem ? (
        <p className="os-mp-hint os-mp-hint--warn">
          <StatusMark kind="warn" label="note" /> {problem}
        </p>
      ) : null}
      {error ? (
        <p className="os-mp-error" role="alert">
          <StatusMark kind="error" /> {error}
        </p>
      ) : null}

      <div className="os-mp-row-actions">
        <button type="button" className="os-btn os-btn--primary" onClick={() => void save()} disabled={!dirty || Boolean(problem) || busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && !dirty ? (
          <span className="os-mp-hint" role="status">
            <StatusMark kind="ok" label="saved" /> Saved.
          </span>
        ) : null}
      </div>
    </section>
  );
}
