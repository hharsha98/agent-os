import { useId } from "react";

// The Fleet card's hero element: a 60-second window of 1-second buckets.
// Bar height is proportional to real stream-event counts for that second;
// the window scrolls once per second only while a live run exists. With no
// live run this renders a flat, dim, static lane — visible (tick marks +
// dashed baseline) but never a fake animation.
const WIDTH = 240;
const HEIGHT = 40;
const BUCKETS = 60;
const BAR_GAP = 1;
const TICK_COUNT = 6; // one every 10s across the 60s window

export default function ActivityTrace({ buckets, live }: { buckets: number[]; live: boolean }) {
  const barWidth = WIDTH / BUCKETS - BAR_GAP;
  const max = Math.max(1, ...buckets);
  const glowId = useId();

  return (
    <div className={`os-trace${live ? " os-trace--live" : ""}`} aria-hidden={!live}>
      <div className="os-trace__lane">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className="os-trace__svg">
          <defs>
            <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="1.4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {Array.from({ length: TICK_COUNT }, (_, i) => (
            <line
              key={i}
              x1={i * (WIDTH / TICK_COUNT)}
              y1={0}
              x2={i * (WIDTH / TICK_COUNT)}
              y2={HEIGHT}
              className="os-trace__tick"
            />
          ))}
          <line x1={0} y1={HEIGHT - 2} x2={WIDTH} y2={HEIGHT - 2} className="os-trace__baseline" />
          {live
            ? buckets.map((count, index) => {
                const h = count > 0 ? Math.max(3, (count / max) * (HEIGHT - 4)) : 1.5;
                const x = index * (barWidth + BAR_GAP);
                const y = HEIGHT - h;
                return (
                  <rect
                    key={index}
                    x={x}
                    y={y}
                    width={barWidth}
                    height={h}
                    rx={1}
                    filter={count > 0 ? `url(#${glowId})` : undefined}
                    className={count > 0 ? "os-trace__bar os-trace__bar--active" : "os-trace__bar"}
                  />
                );
              })
            : null}
        </svg>
      </div>
      {/* The time axis sits under the lane so live bars never cover it. */}
      <div className="os-trace__axis">
        <span className="os-micro">−60s</span>
        <span className="os-micro">
          now · <span className="os-trace__label">{live ? "live" : "idle"}</span>
        </span>
      </div>
    </div>
  );
}

export function emptyBuckets() {
  return new Array(BUCKETS).fill(0);
}

export { BUCKETS as ACTIVITY_TRACE_BUCKETS };
