// The Fleet card's hero element: a 60-second window of 1-second buckets.
// Bar height is proportional to real stream-event counts for that second;
// the window scrolls once per second only while a live run exists. With no
// live run this renders a flat, dim, unlabelled-motion baseline — never a
// fake animation.
const WIDTH = 240;
const HEIGHT = 40;
const BUCKETS = 60;
const BAR_GAP = 1;

export default function ActivityTrace({ buckets, live }: { buckets: number[]; live: boolean }) {
  const barWidth = WIDTH / BUCKETS - BAR_GAP;
  const max = Math.max(1, ...buckets);

  return (
    <div className="os-trace" aria-hidden={!live}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className="os-trace__svg">
        {live ? (
          buckets.map((count, index) => {
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
                className={count > 0 ? "os-trace__bar os-trace__bar--active" : "os-trace__bar"}
              />
            );
          })
        ) : (
          <line x1={0} y1={HEIGHT - 2} x2={WIDTH} y2={HEIGHT - 2} className="os-trace__baseline" />
        )}
      </svg>
      <span className="os-trace__label os-micro">{live ? "live" : "idle"}</span>
    </div>
  );
}

export function emptyBuckets() {
  return new Array(BUCKETS).fill(0);
}

export { BUCKETS as ACTIVITY_TRACE_BUCKETS };
