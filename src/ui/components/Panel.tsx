import type { ReactNode } from "react";

export default function Panel({
  children,
  raised = false,
  className = ""
}: {
  children: ReactNode;
  raised?: boolean;
  className?: string;
}) {
  return <div className={`os-panel${raised ? " os-panel--raised" : ""} ${className}`.trim()}>{children}</div>;
}
