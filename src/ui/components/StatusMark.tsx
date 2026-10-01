// A status shape + colour together, never colour alone: a hollow ring for
// unknown, a filled dot for ok, a triangle for warn, a square for error,
// and a filled dot that pulses once for a real live event.
export type StatusKind = "ok" | "warn" | "error" | "unknown" | "live";

export default function StatusMark({
  kind,
  pulse = false,
  label
}: {
  kind: StatusKind;
  pulse?: boolean;
  label?: string;
}) {
  const className = `os-mark os-mark--${kind}${pulse ? " os-mark--pulse" : ""}`;
  return (
    <span className={className} role="img" aria-label={label || kind} title={label}>
      {kind === "unknown" ? (
        <svg viewBox="0 0 10 10">
          <circle cx="5" cy="5" r="4" />
        </svg>
      ) : kind === "warn" ? (
        <svg viewBox="0 0 10 10">
          <polygon points="5,0.5 9.5,9.2 0.5,9.2" />
        </svg>
      ) : kind === "error" ? (
        <svg viewBox="0 0 10 10">
          <rect x="1" y="1" width="8" height="8" rx="1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 10 10">
          <circle cx="5" cy="5" r="4" />
        </svg>
      )}
    </span>
  );
}
