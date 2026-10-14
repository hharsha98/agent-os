// The Safety level control: three buttons, one per level, and a table of what the current level
// allows, asks about and blocks. Decision D-D2-2: arrow keys never change the level (a safety
// level must not change because focus moved); Enter or Space on a level does what that level needs.
//
// The current level's button is NOT disabled. A disabled button loses keyboard focus, and the
// dialogs return focus to the button that opened them, so a level changed from the keyboard would
// drop the person's place. Pressing the current level does nothing (the page ignores it).
import { Check, CircleHelp, Lock, ShieldCheck } from "lucide-react";
import { ENV_LOCK_WORDS, LEVEL_DETAIL, LEVEL_UNKNOWN_NOTE, LEVELS, LEVELS_QUIET, levelButtonId, levelFoot, levelHeading } from "../safetyShared";

type Level = 0 | 1 | 2;
const ROWS = [
  { key: "can", word: "Agents can", Icon: ShieldCheck, tone: "ok" },
  { key: "asks", word: "Needs your say-so", Icon: CircleHelp, tone: "warn" },
  { key: "cannot", word: "Agents cannot", Icon: Lock, tone: "idle" }
] as const;

export default function SafetyLevels({
  current,
  countdown,
  supported,
  envLocked = false,
  lastKnown = false,
  changing = null,
  onPick
}: {
  // null until the server has said which level it is (never guessed).
  current: Level | null;
  countdown: string;
  supported: boolean;
  // The gate is locked on by this computer's settings: Look only cannot be reached from here.
  envLocked?: boolean;
  // Contact with Agent OS was lost: the level shown is the last one it reported.
  lastKnown?: boolean;
  // The level whose change is on its way (the request, then the re-check), if any.
  changing?: Level | null;
  onPick: (n: Level) => void;
}) {
  const detail = current === null ? null : LEVEL_DETAIL[current];
  return (
    <section className="os-saf-section" aria-labelledby="os-saf-levels-title">
      <div className="os-saf-section__head">
        <h2 id="os-saf-levels-title">How much may agents do?</h2>
        <p className="os-saf-section__quiet">{LEVELS_QUIET}</p>
      </div>
      <div className="os-saf-ladder" aria-hidden="true">
        <span>Less power</span>
        <span className="os-saf-ladder__line" />
        <span>More power</span>
      </div>
      <div className="os-saf-levels" role="group" aria-label="Safety level" aria-busy={current === null}>
        {([0, 1, 2] as Level[]).map((n) => {
          const on = current === n;
          const unsupported = n === 2 && !supported;
          const locked = n === 0 && envLocked && !on;
          const busy = changing === n;
          return (
            <button
              key={n}
              id={levelButtonId(n)}
              type="button"
              className={`os-saf-level${on ? " is-current" : ""}${n === 2 && on ? " is-armed" : ""}`}
              aria-pressed={on}
              aria-busy={busy || undefined}
              disabled={current === null || unsupported}
              onClick={() => {
                if (!on) onPick(n);
              }}
            >
              <span className="os-saf-level__n os-mono" aria-hidden="true">{n}</span>
              <span className="os-saf-level__text">
                <span className="os-saf-level__t">{LEVELS[n].label}</span>
                <span className="os-saf-level__d">{unsupported ? "Only available on macOS." : locked ? ENV_LOCK_WORDS : LEVELS[n].blurb}</span>
              </span>
              <span className="os-saf-level__f">
                {on && n !== 2 ? <Check size={13} aria-hidden="true" /> : n === 2 && !on && supported ? <Lock size={13} aria-hidden="true" /> : null}
                {levelFoot(n, current, countdown, { supported, envLocked, lastKnown, changing: busy })}
              </span>
            </button>
          );
        })}
      </div>
      {current === null ? <span className="os-visually-hidden" role="status">Checking the current safety level</span> : null}
      {changing !== null ? <span className="os-visually-hidden" role="status">Changing the safety level</span> : null}
      <div className="os-saf-detail" aria-live="polite">
        <h3>{levelHeading(current)}</h3>
        {current === null || detail === null ? (
          // No level is known, so no level's table is shown (it would explain a level nobody confirmed).
          <p className="os-saf-detail__none">{LEVEL_UNKNOWN_NOTE}</p>
        ) : (
          <div className="os-table os-saf-can" role="table" aria-label={`What Level ${current} allows`}>
            {ROWS.map(({ key, word, Icon, tone }) => (
              <div key={key} className="os-table__row" role="row">
                <div className={`os-table__cell os-saf-can__w os-saf-can__w--${tone}`} role="cell">
                  <Icon size={16} aria-hidden="true" />
                  {word}
                </div>
                <div className="os-table__cell" role="cell">{detail[key]}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
