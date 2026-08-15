import { Search } from "lucide-react";
import { HonestNote, PageFrame } from "./PageFrame";

export default function SeoPage() {
  return (
    <PageFrame
      kicker="SEO · PRODUCTION LAYER"
      title="The video’s SEO desk. Parked on this Mac."
      hint="In the YouTube blueprint, production includes an SEO section that already knows your niche. This runtime has SEO APIs, but they are parked on purpose so we do not pretend Keyword Tools / rank tracking are live."
    >
      <HonestNote>
        Parked means the server refuses those jobs instead of faking a green “content shipped” state. Keyword research, page builds, and rank snapshots stay off until you approve that work later.
      </HonestNote>
      <div className="aos-studio-grid">
        <article className="aos-panel">
          <div className="aos-panel-head"><div><span>AUDIT</span><h2>Parked</h2></div></div>
          <p>SEO brief audit would live here. The API returns a parked rejection today.</p>
        </article>
        <article className="aos-panel">
          <div className="aos-panel-head"><div><span>DISCOVER</span><h2>Parked</h2></div></div>
          <p>Keyword discovery is not connected. No fake keyword list is shown.</p>
        </article>
        <article className="aos-panel">
          <div className="aos-panel-head"><div><span>RANK</span><h2>Parked</h2></div></div>
          <p>Rank snapshots are not running. Use Notebook for research notes you type yourself.</p>
        </article>
      </div>
      <p className="aos-honest-note"><Search size={14} /> To turn this on later we would un-park the SEO module after you say yes — not before.</p>
    </PageFrame>
  );
}
