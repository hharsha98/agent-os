// A small segmented choice (Keep | Update, Install | Skip) built as a radio group:
// one button is the tab stop, the arrow keys move the choice, a disabled option
// is skipped. Used by the Plan step.
import { useRef } from "react";

export interface SegmentOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export default function SetupSegmented({
  label,
  value,
  options,
  onChange,
  disabled = false
}: {
  label: string;
  value: string;
  options: SegmentOption[];
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const usable = options.map((o, i) => (!disabled && !o.disabled ? i : -1)).filter((i) => i >= 0);
  const checkedIndex = options.findIndex((o) => o.value === value && !o.disabled);
  // Exactly one button is a tab stop: the chosen one, or else the first usable one.
  const stop = checkedIndex >= 0 ? checkedIndex : (usable[0] ?? -1);

  function move(from: number, step: 1 | -1) {
    const at = usable.indexOf(from);
    if (at < 0 || usable.length < 2) return;
    const next = usable[(at + step + usable.length) % usable.length];
    onChange(options[next].value);
    buttons.current[next]?.focus();
  }

  return (
    <div className="os-setup-seg" role="radiogroup" aria-label={label}>
      {options.map((option, i) => (
        <button
          key={option.value}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className="os-setup-seg__btn"
          disabled={disabled || Boolean(option.disabled)}
          tabIndex={i === stop ? 0 : -1}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              move(i, 1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              move(i, -1);
            }
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
