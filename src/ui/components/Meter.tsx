import { useId } from "react";

// One continuous gauge, 0 to 1 (context used, plan used). `null` is an honest
// "—": the value is not known, so no bar is drawn. Not to be confused with
// SegmentMeter (one segment per agent, class .os-meter): this one is .os-gauge.
// For the warn and danger tones, put the reason in `detail` in words, because
// the colour alone must not carry the meaning.
export interface MeterProps {
  label: string;
  value: number | null;
  detail?: string;
  tone?: "accent" | "warn" | "danger";
}

export default function Meter({ label, value, detail, tone = "accent" }: MeterProps) {
  const labelId = useId();
  const detailId = useId();
  const ratio = typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
  const percent = ratio === null ? null : Math.round(ratio * 100);
  return (
    <div className={`os-gauge os-gauge--${tone}`}>
      <div className="os-gauge__top">
        <span id={labelId} className="os-gauge__label">
          {label}
        </span>
        <span className="os-gauge__value os-mono">
          {percent === null ? (
            <>
              <span aria-hidden="true">—</span>
              <span className="os-visually-hidden">unknown</span>
            </>
          ) : (
            `${percent}%`
          )}
        </span>
      </div>
      <div
        className="os-gauge__track"
        role={percent === null ? undefined : "meter"}
        aria-hidden={percent === null ? true : undefined}
        aria-labelledby={percent === null ? undefined : labelId}
        aria-describedby={percent !== null && detail ? detailId : undefined}
        aria-valuemin={percent === null ? undefined : 0}
        aria-valuemax={percent === null ? undefined : 100}
        aria-valuenow={percent ?? undefined}
      >
        <span className="os-gauge__fill" style={{ width: `${percent ?? 0}%` }} />
      </div>
      {detail ? (
        <p id={detailId} className="os-gauge__detail">
          {detail}
        </p>
      ) : null}
    </div>
  );
}
