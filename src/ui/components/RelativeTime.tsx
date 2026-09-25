import { useEffect, useState } from "react";

function elapsedLabel(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// True elapsed time since `since`, ticking once a second while `live` is
// true. Never a fabricated progress bar — just the real clock.
export default function RelativeTime({ since, live = false }: { since: string | number | Date; live?: boolean }) {
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [live]);

  const startMs = new Date(since).getTime();
  if (!Number.isFinite(startMs)) return <span>—</span>;
  const label = elapsedLabel(Date.now() - startMs);
  return <span className="os-mono">{label}</span>;
}

export function agoLabel(since: string | number | Date) {
  const startMs = new Date(since).getTime();
  if (!Number.isFinite(startMs)) return "—";
  const diff = Date.now() - startMs;
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
