import type { ReactNode } from "react";

// The top of every core page: an optional small caption, the page's one h1,
// a plain-English lede and the page's main actions. The actions sit on the
// right and wrap under the title in a narrow window.
export interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  titleId?: string;
  lede?: ReactNode;
  actions?: ReactNode;
}

export default function PageHeader({ eyebrow, title, titleId, lede, actions }: PageHeaderProps) {
  return (
    <header className="os-page-head">
      <div className="os-page-head__text">
        {eyebrow ? <p className="os-page-head__eyebrow os-micro">{eyebrow}</p> : null}
        <h1 id={titleId} className="os-page-head__title">
          {title}
        </h1>
        {lede ? <div className="os-page-head__lede">{lede}</div> : null}
      </div>
      {actions ? <div className="os-page-head__actions">{actions}</div> : null}
    </header>
  );
}
