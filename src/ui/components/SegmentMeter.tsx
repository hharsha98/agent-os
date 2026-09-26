// A row of segments under an instrument readout — one per real unit (an
// agent, a gateway). Filled = ok, hollow = unknown/not present. There is no
// "needs setup" segment: the agent-detection API only reports installed vs
// not, so a third colour there would be a fabricated state.
export type MeterSegmentState = "ok" | "unknown";

export default function SegmentMeter({ segments, label }: { segments: MeterSegmentState[]; label: string }) {
  return (
    <div className="os-meter" role="img" aria-label={label}>
      {segments.map((state, index) => (
        <span key={index} className={`os-meter__seg os-meter__seg--${state}`} />
      ))}
    </div>
  );
}
