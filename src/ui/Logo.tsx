import { useId } from "react";

// The Agent OS "Orbit" mark (design spec D2): a ring with five agents on it,
// the lit one in cobalt and the ring cut around it. Drawn from the approved
// prototype's shared/logo.svg on a 24-unit grid. Decorative unless a title is
// given. The mask id is unique per instance so two marks never share one.
interface LogoProps {
  size?: number;
  title?: string;
  className?: string;
}

export default function Logo({ size = 24, title, className }: LogoProps) {
  const maskId = `aos-cut-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <g transform="translate(-0.9 0)">
        <mask id={maskId} maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28">
          <rect x="-2" y="-2" width="28" height="28" fill="#fff" />
          <circle cx="19.99" cy="9.4" r="4" fill="#000" />
        </mask>
        <circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" strokeWidth="1.8" mask={`url(#${maskId})`} />
        <circle cx="12" cy="3.6" r="1.85" fill="currentColor" />
        <circle cx="16.94" cy="18.8" r="1.85" fill="currentColor" />
        <circle cx="7.06" cy="18.8" r="1.85" fill="currentColor" />
        <circle cx="4.01" cy="9.4" r="1.85" fill="currentColor" />
        <circle cx="19.99" cy="9.4" r="3" fill="var(--os-accent)" />
      </g>
    </svg>
  );
}
