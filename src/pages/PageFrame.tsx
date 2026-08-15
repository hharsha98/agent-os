import type { ReactNode } from "react";

export function PageFrame({
  kicker,
  title,
  hint,
  actions,
  children
}: {
  kicker: string;
  title: string;
  hint: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="aos-page aos-phase-page">
      <section className="aos-section">
        <div className="aos-section-head">
          <div>
            <span>{kicker}</span>
            <h2>{title}</h2>
            <p>{hint}</p>
          </div>
          {actions ? <div className="aos-phase-actions">{actions}</div> : null}
        </div>
        {children}
      </section>
    </main>
  );
}

export function HonestNote({ children }: { children: ReactNode }) {
  return <p className="aos-honest-note">{children}</p>;
}
