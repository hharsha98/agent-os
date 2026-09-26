// A large mono readout: a real number (or "—" for honestly unknown), a
// micro label, and an optional hint explaining why it's unknown. `big` is
// for the instrument bar's display-scale numerals; a "/5"-style suffix is
// split off and rendered smaller so the real number reads first.
export default function Readout({
  label,
  value,
  hint,
  muted = false,
  big = false
}: {
  label: string;
  value: string;
  hint?: string;
  muted?: boolean;
  big?: boolean;
}) {
  const slashAt = value.indexOf("/");
  const main = slashAt === -1 ? value : value.slice(0, slashAt);
  const denom = slashAt === -1 ? null : value.slice(slashAt);
  return (
    <div className="os-readout">
      <span className="os-readout__label">{label}</span>
      <span
        className={`os-readout__value os-mono${muted ? " os-readout__value--muted" : ""}${big ? " os-readout__value--big" : ""}`}
        title={hint}
      >
        {main}
        {denom ? <span className="os-readout__denom">{denom}</span> : null}
      </span>
      {hint ? <span className="os-readout__hint">{hint}</span> : null}
    </div>
  );
}
