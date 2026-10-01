import type { ReactNode } from "react";
import StatusMark, { type StatusKind } from "./StatusMark";

export default function Chip({
  children,
  mark,
  experimental = false
}: {
  children: ReactNode;
  mark?: StatusKind;
  experimental?: boolean;
}) {
  return (
    <span className={`os-chip${experimental ? " os-chip--experimental" : ""}`}>
      {mark ? <StatusMark kind={mark} /> : null}
      {children}
    </span>
  );
}
