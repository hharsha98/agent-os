// A large mono readout: a real number (or "—" for honestly unknown), a
// micro label, and an optional hint explaining why it's unknown.
export default function Readout({
  label,
  value,
  hint,
  muted = false
}: {
  label: string;
  value: string;
  hint?: string;
  muted?: boolean;
}) {
  return (
    <div className="os-readout">
      <span className="os-readout__label">{label}</span>
      <span className={`os-readout__value os-mono${muted ? " os-readout__value--muted" : ""}`} title={hint}>
        {value}
      </span>
      {hint ? <span className="os-readout__hint">{hint}</span> : null}
    </div>
  );
}
