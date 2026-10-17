import { Activity, CircleDashed, CircleHelp } from "lucide-react";
import { HOME_AGENTS, type HomeAgentId, type OrbitStates } from "../homeShared";

const W = 470, H = 340, CX = 222, CY = 190, R = 144;
const ANGLE: Record<HomeAgentId, number> = { hermes: 220, openclaw: 140, claude: -56, codex: 0, cursor: 56 };
const TONE = {
  live: { stroke: "var(--os-accent)", text: "var(--os-accent-strong)", word: "Live", Icon: Activity },
  waiting: { stroke: "var(--os-warn)", text: "var(--os-warn)", word: "Waiting", Icon: CircleHelp }
} as const;
const rad = (a: number) => (a * Math.PI) / 180;
const pt = (a: number, r: number) => [CX + r * Math.cos(rad(a)), CY + r * Math.sin(rad(a))] as const;
const TICKS = Array.from({ length: 60 }, (_, i) => i);

export default function Orbit({ states, label, note }: { states: OrbitStates; label: string; note: string }) {
  return (
    <figure className="os-orbit">
      <svg className="os-orbit__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        <line className="os-orbit__divider" x1={CX} y1={40} x2={CX} y2={H - 8} />
        <text className="os-orbit__group" x={CX - 14} y={20} textAnchor="end">Operators</text>
        <text className="os-orbit__group" x={CX + 14} y={20} textAnchor="start">Builders</text>
        <line className="os-orbit__rule" x1={CX - 14} y1={30.5} x2={CX - 118} y2={30.5} />
        <line className="os-orbit__rule" x1={CX + 14} y1={30.5} x2={CX + 118} y2={30.5} />
        <circle className="os-orbit__ring" cx={CX} cy={CY} r={R} />
        <circle className="os-orbit__ring os-orbit__ring--inner" cx={CX} cy={CY} r={R - 54} />
        {HOME_AGENTS.map(({ id }) => {
          const state = states[id];
          const tone = state ? TONE[state] : null;
          const [x1, y1] = pt(ANGLE[id], 78);
          const [x2, y2] = pt(ANGLE[id], R - 11);
          const [mx, my] = pt(ANGLE[id], 78 + (R - 89) * 0.58);
          return tone ? (
            <g key={`c-${id}`}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} style={{ stroke: tone.stroke }} strokeWidth={2.4} strokeLinecap="round" />
              <circle cx={mx} cy={my} r={3} style={{ fill: tone.stroke }} />
            </g>
          ) : (
            <line key={`c-${id}`} className="os-orbit__connector" x1={x1} y1={y1} x2={x2} y2={y2} />
          );
        })}
        {TICKS.map((i) => {
          const [ax, ay] = pt(i * 6, 59);
          const [bx, by] = pt(i * 6, i % 5 === 0 ? 67 : 63);
          return <line key={`t-${i}`} className={i % 5 === 0 ? "os-orbit__tick os-orbit__tick--major" : "os-orbit__tick"} x1={ax} y1={ay} x2={bx} y2={by} />;
        })}
        <circle className="os-orbit__face" cx={CX} cy={CY} r={51} />
        <circle className="os-orbit__face-edge" cx={CX} cy={CY} r={43.5} />
        <text className="os-orbit__core" x={CX} y={CY + 1} textAnchor="middle">Agent OS</text>
        <text className="os-orbit__version" x={CX} y={CY + 16} textAnchor="middle">v{__APP_VERSION__}</text>
        {HOME_AGENTS.map(({ id, name, maker }) => {
          const state = states[id];
          const tone = state ? TONE[state] : null;
          const [px, py] = pt(ANGLE[id], 73);
          const [x, y] = pt(ANGLE[id], R);
          const left = ANGLE[id] > 90 && ANGLE[id] < 270;
          const tx = left ? x - 18 : x + 18;
          const anchor = left ? "end" : "start";
          const dy = tone ? -8 : -2;
          const wordWidth = tone ? tone.word.length * 6.3 + 20 : 0;
          return (
            <g key={`n-${id}`} data-agent={id} data-state={state ?? "dim"}>
              <circle className="os-orbit__port" cx={px} cy={py} r={2.6} style={tone ? { stroke: tone.stroke } : undefined} />
              <circle className="os-orbit__node" cx={x} cy={y} r={9} style={tone ? { stroke: tone.stroke } : undefined} />
              <circle className="os-orbit__dot" cx={x} cy={y} r={3.2} style={tone ? { fill: tone.stroke } : undefined} />
              <text className="os-orbit__name" x={tx} y={y + dy} textAnchor={anchor}>{name}</text>
              <text className="os-orbit__maker" x={tx} y={y + dy + 16} textAnchor={anchor}>{maker}</text>
              {tone ? (
                <>
                  <tone.Icon x={left ? tx - wordWidth : tx} y={y + dy + 20} width={14} height={14} color={tone.text} aria-hidden="true" />
                  <text className="os-orbit__state" x={left ? tx : tx + 20} y={y + dy + 32} textAnchor={anchor}>{tone.word}</text>
                </>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="os-orbit__note">
        <CircleDashed size={15} aria-hidden="true" />
        <span>{note}</span>
      </figcaption>
    </figure>
  );
}
