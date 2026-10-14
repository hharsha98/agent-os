import { OctagonX } from "lucide-react";

// What the red "Hold to stop all" button does and does not stop (design spec D11, decision D-D2-6).
// The facts are src/ui/stopAll.ts (agent runs, Team Room turns included; never the Hermes
// background service, the OpenClaw Gateway or Agent OS's own setup jobs) and HoldToStopAll.tsx
// (a hold of 1.2 s; Space or Enter on the focused button; the same stop through ⌘K).
const FRAMES = [
  { fill: 0, time: "0 s", label: "Hold to stop all", caption: "You press. Nothing has happened yet." },
  { fill: 0.5, time: "0.6 s", label: "Keep holding…", caption: "Keep holding. Letting go cancels." },
  { fill: 1, time: "1.2 s", label: "Keep holding…", caption: "Full. All agent work stops." }
];

export default function SafetyStopInfo() {
  return (
    <section className="os-saf-section" aria-labelledby="os-saf-stop-title">
      <div className="os-saf-section__head">
        <h2 id="os-saf-stop-title">Hold to stop all</h2>
        <p className="os-saf-section__quiet">The red button in the top bar, on every page</p>
      </div>
      <div className="os-saf-stop">
        <div>
          <p className="os-saf-stop__lede">One press and hold stops all agent work at once. The hold is on purpose, so a stray click can never end your work.</p>
          <ol className="os-saf-stop__steps">
            <li>Press and hold the button for about a second.</li>
            <li>A red fill grows across it. Let go early and nothing happens.</li>
            <li>When the fill is full, Agent OS stops every agent run, Team Room turns included. Files already changed stay as they are.</li>
          </ol>
          <p className="os-saf-stop__keys">
            Without a mouse: focus the button and hold Space or Enter, or open search with ⌘K or Ctrl K and choose Stop all runs.
          </p>
          <p className="os-saf-stop__not">
            It does not stop the Hermes background service or the OpenClaw Gateway, and it leaves Agent OS&apos;s own setup jobs running. Each service has its own Stop on Agents.
          </p>
        </div>
        <div className="os-saf-frames" aria-hidden="true">
          {FRAMES.map((frame) => (
            <div key={frame.time} className="os-saf-frame">
              <span className={`os-saf-frame__btn${frame.fill > 0 ? " is-filled" : ""}`}>
                <span className="os-saf-frame__fill" style={{ transform: `scaleX(${frame.fill})` }} />
                <OctagonX size={15} />
                <span>{frame.label}</span>
              </span>
              <span className="os-saf-frame__t"><span className="os-mono">{frame.time}</span> {frame.caption}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
