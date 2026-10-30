// Help: "How a session works" (the prototype's how-it-works.html). Not in the menu: Safety's "How stopping works" and
// the Sessions page's "How a session works" link here. Every sentence is true today: the alerts lane is told in words
// (alertWords, SP4), while the prototype's Lane B drawing, its hand-off item (Task X8) and its "Review guide" button are
// left out. What closing the window does depends on where Agent OS runs (lifeSection, helpShared.ts). The diagrams are
// the prototype's SVGs on the app's tokens.
import { useEffect } from "react";
import type { CSSProperties } from "react";
import { CircleHelp, CircleStop, History, Lock, Maximize, Power, SquareTerminal, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import PageHeader from "../ui/components/PageHeader";
import { isDesktopApp } from "../ui/desktop";
import { ALERTS_TITLE, GLOSSARY, HELP_LEDE, HELP_TITLE, PROMISES, ROUTE_QUIET, ROUTE_TITLE, ROUTE_WORDS, alertWords, lifeSection } from "../ui/helpShared";
import type { LifeStep } from "../ui/helpShared";
import "../ui/help.css";

const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent || "");
const STEP_ICON: Record<LifeStep["id"], LucideIcon> = { close: X, reopen: Maximize, quit: Power, resume: History };
const PROMISE_ICON: Record<string, LucideIcon> = { stop: CircleStop, flags: Lock, answers: CircleHelp };
const AGENT_CHIPS: Array<[number, number, number, string]> = [
  [832, 104, 62, "claude"],
  [902, 104, 56, "codex"],
  [966, 104, 54, "agent"],
  [832, 138, 62, "hermes"],
  [902, 138, 78, "openclaw"]
];

// The prototype's lane A only (lane B, the alerts, is SP4): the window, the private connection, the engine (with its
// real terminal, invisible screen copy and local recording) and the agent's own program.
function RouteDiagram({ engineNote }: { engineNote: string }) {
  return (
    <svg className="os-help-svg" viewBox="24 0 1012 340" role="img" aria-labelledby="os-help-route-t os-help-route-d">
      <title id="os-help-route-t">How typing travels between the Agent OS window and an agent</title>
      <desc id="os-help-route-d">
        Your keys go from the Agent OS window over a private connection to the engine on your computer, which types them into the agent&apos;s real
        terminal. The agent&apos;s screen goes back through an invisible screen copy, which is also recorded on this computer, and is streamed to your
        window.
      </desc>
      <defs>
        <marker id="os-help-ah-g" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M1.5 1.5 8.5 5 1.5 8.5" className="os-help-arrow os-help-arrow--g" />
        </marker>
        <marker id="os-help-ah-b" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M1.5 1.5 8.5 5 1.5 8.5" className="os-help-arrow os-help-arrow--b" />
        </marker>
      </defs>

      {/* The private connection, drawn behind the arrows that travel through it. */}
      <rect x="250" y="92" width="128" height="156" rx="8" className="os-help-ws" />
      <text x="314" y="110" textAnchor="middle" className="os-help-s os-help-blue os-help-strong">
        Private connection
      </text>
      <text x="314" y="126" textAnchor="middle" className="os-help-m os-help-blue">
        a WebSocket
      </text>

      {/* Agent OS window */}
      <rect x="24" y="36" width="220" height="200" rx="10" className="os-help-box" />
      <text x="40" y="66" className="os-help-t">
        Agent OS window
      </text>
      <text x="40" y="86" className="os-help-s">
        What you see and type into
      </text>
      <rect x="40" y="104" width="188" height="116" rx="6" className="os-help-screen" />
      <rect x="48" y="112" width="62" height="16" rx="3" className="os-help-tab" />
      <rect x="114" y="112" width="62" height="16" rx="3" className="os-help-tab2" />
      <rect x="48" y="142" width="118" height="5" rx="2.5" className="os-help-l8" />
      <rect x="48" y="154" width="150" height="5" rx="2.5" className="os-help-l4" />
      <rect x="48" y="166" width="96" height="5" rx="2.5" className="os-help-l2" />
      <rect x="48" y="178" width="132" height="5" rx="2.5" className="os-help-l8" />
      <rect x="48" y="192" width="7" height="12" className="os-help-cursor" />

      {/* Engine */}
      <rect x="384" y="36" width="282" height="292" rx="10" className="os-help-box" />
      <text x="400" y="66" className="os-help-t">
        Engine on your computer
      </text>
      <text x="400" y="86" className="os-help-s">
        {engineNote}
      </text>
      <text x="400" y="112" className="os-help-s os-help-strong">
        Session manager
      </text>
      <rect x="400" y="124" width="250" height="52" rx="8" className="os-help-part" />
      <text x="414" y="146" className="os-help-t14">
        Real terminal
      </text>
      <text x="414" y="164" className="os-help-s">
        a pseudo-terminal for the agent
      </text>
      <path d="M525 177 V190" className="os-help-line os-help-line--g" markerEnd="url(#os-help-ah-g)" />
      <rect x="400" y="192" width="250" height="52" rx="8" className="os-help-part" />
      <text x="414" y="214" className="os-help-t14">
        Invisible screen copy
      </text>
      <text x="414" y="232" className="os-help-s">
        always knows what is on screen
      </text>
      <path d="M525 245 V258" className="os-help-line os-help-line--g" markerEnd="url(#os-help-ah-g)" />
      <rect x="400" y="260" width="250" height="52" rx="8" className="os-help-part" />
      <text x="414" y="282" className="os-help-t14">
        Local recording
      </text>
      <text x="414" y="300" className="os-help-s">
        saved on this computer
      </text>

      {/* Agent program */}
      <rect x="816" y="36" width="220" height="200" rx="10" className="os-help-box" />
      <text x="832" y="66" className="os-help-t">
        Agent program
      </text>
      <text x="832" y="86" className="os-help-s">
        The program you picked
      </text>
      {AGENT_CHIPS.map(([x, y, w, label]) => (
        <g key={label}>
          <rect x={x} y={y} width={w} height="26" rx="5" className="os-help-part" />
          <text x={x + w / 2} y={y + 17.5} textAnchor="middle" className="os-help-m">
            {label}
          </text>
        </g>
      ))}
      <text x="832" y="190" className="os-help-s">
        Claude Code, Codex, Cursor,
      </text>
      <text x="832" y="208" className="os-help-s">
        Hermes, OpenClaw
      </text>

      {/* The arrows */}
      <text x="314" y="158" textAnchor="middle" className="os-help-s">
        you type
      </text>
      <path d="M246 166 H398" className="os-help-line os-help-line--b" markerEnd="url(#os-help-ah-b)" />
      <text x="314" y="212" textAnchor="middle" className="os-help-s">
        the screen
      </text>
      <path d="M398 222 H246" className="os-help-line os-help-line--b" markerEnd="url(#os-help-ah-b)" />
      <text x="741" y="130" textAnchor="middle" className="os-help-s">
        what you typed
      </text>
      <path d="M652 140 H814" className="os-help-line os-help-line--g" markerEnd="url(#os-help-ah-g)" />
      <path d="M814 166 H652" className="os-help-line os-help-line--g" markerEnd="url(#os-help-ah-g)" />
      <text x="741" y="186" textAnchor="middle" className="os-help-s">
        what it draws
      </text>
    </svg>
  );
}

// The prototype's timeline under the four steps: shown only where closing the window hides it (macOS desktop app).
function Timeline() {
  const bar = (x: number, y: number, w: number, kind: "solid" | "live" | "dash", label: string) => (
    <g key={`${x}-${y}`}>
      <rect x={x} y={y} width={w} height="22" rx="4" className={`os-help-bar--${kind}`} />
      <text x={x + 10} y={y + 15.5} className={kind === "live" ? "os-help-s os-help-blue os-help-strong" : "os-help-s"}>
        {label}
      </text>
    </g>
  );
  return (
    <svg className="os-help-svg" viewBox="0 0 1060 152" role="img" aria-labelledby="os-help-time-t os-help-time-d">
      <title id="os-help-time-t">The window and your sessions across the four steps</title>
      <desc id="os-help-time-d">
        Step 1: the window is closed and the sessions keep running. Step 2: the window is open again and the sessions are still running. Step 3: Agent
        OS is quit, the window is gone and the sessions end. Step 4: Agent OS is opened again and the conversation continues through the agent&apos;s own
        resume.
      </desc>
      <g className="os-help-sep">
        <line x1="265" y1="2" x2="265" y2="126" />
        <line x1="530" y1="2" x2="530" y2="126" />
        <line x1="795" y1="2" x2="795" y2="126" />
      </g>
      <text x="0" y="16" className="os-help-lane">
        Agent OS window
      </text>
      {bar(0, 26, 261, "dash", "closed")}
      {bar(269, 26, 257, "solid", "open again, screen restored")}
      {bar(534, 26, 257, "dash", "Agent OS is not running")}
      {bar(799, 26, 261, "solid", "open")}
      <text x="0" y="84" className="os-help-lane">
        Your sessions
      </text>
      {bar(0, 94, 518, "live", "Running the whole time, window open or not")}
      <CircleStop x={521} y={96} size={18} className="os-help-warn-icon" aria-hidden="true" />
      {bar(545, 94, 246, "dash", "can be resumed")}
      {bar(799, 94, 261, "live", "conversation continues")}
      <text x="530" y="140" className="os-help-s">
        ended on quit
      </text>
      <text x="799" y="140" className="os-help-s">
        through the agent&apos;s own resume
      </text>
    </svg>
  );
}

export default function HelpPage() {
  const life = lifeSection({ desktop: isDesktopApp(), isMac: IS_MAC });
  // The page scrolls as a whole, so Help opened from a page that was scrolled (Safety's "How stopping works", the
  // Sessions page's link) would keep that place. It starts at its own top, with its title on screen.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  return (
    <section className="os-help" aria-labelledby="os-help-title">
      <PageHeader titleId="os-help-title" title={HELP_TITLE} lede={HELP_LEDE} />

      <section className="os-help-section" aria-labelledby="os-help-route">
        <div className="os-help-section__head">
          <h2 id="os-help-route">{ROUTE_TITLE}</h2>
          <p className="os-help-section__quiet">{ROUTE_QUIET}</p>
        </div>
        <RouteDiagram engineNote={life.engineNote} />
        <div className="os-help-legend" aria-hidden="true">
          <span>
            <i className="is-b" />
            Private connection
          </span>
          <span>
            <i />
            Inside your computer
          </span>
        </div>
        <div className="os-help-words">
          <h3>
            <SquareTerminal size={17} aria-hidden="true" />
            In words
          </h3>
          <ol className="os-help-list">
            {ROUTE_WORDS.map((parts, index) => (
              <li key={index}>
                <span>{parts.map((part, i) => (part.bold ? <b key={i}>{part.text}</b> : <span key={i}>{part.text}</span>))}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="os-help-words">
          <h3>
            <CircleHelp size={17} aria-hidden="true" />
            {ALERTS_TITLE}
          </h3>
          <ol className="os-help-list">
            {alertWords({ desktop: isDesktopApp() }).map((parts, index) => (
              <li key={index}>
                <span>{parts.map((part, i) => (part.bold ? <b key={i}>{part.text}</b> : <span key={i}>{part.text}</span>))}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="os-help-section" aria-labelledby="os-help-life">
        <div className="os-help-section__head">
          <h2 id="os-help-life">{life.title}</h2>
          <p className="os-help-section__quiet">{life.quiet}</p>
        </div>
        <ol className="os-help-steps" style={{ "--os-help-steps": life.steps.length } as CSSProperties}>
          {life.steps.map((step, index) => {
            const Icon = STEP_ICON[step.id];
            return (
              <li key={step.id} className={step.id === "quit" ? "is-quit" : undefined}>
                <span className="os-help-n" aria-hidden="true">
                  {index + 1}
                </span>
                <h3>
                  <Icon size={17} aria-hidden="true" />
                  {step.title}
                </h3>
                <p>{step.body}</p>
              </li>
            );
          })}
        </ol>
        {life.timeline ? (
          <div className="os-help-time">
            <Timeline />
          </div>
        ) : null}
      </section>

      <section className="os-help-section" aria-labelledby="os-help-promises">
        {/* Read aloud only, so the page looks as it did: the outline needs an h2 over the three promise titles. */}
        <h2 id="os-help-promises" className="os-visually-hidden">
          Promises
        </h2>
        <div className="os-help-pair">
          {PROMISES.map((promise) => {
            const Icon = PROMISE_ICON[promise.id] || CircleHelp;
            return (
              <div key={promise.id}>
                <h3>
                  <Icon size={20} aria-hidden="true" />
                  {promise.title}
                </h3>
                <p>{promise.body}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="os-help-section" aria-labelledby="os-help-gloss">
        <div className="os-help-section__head">
          <h2 id="os-help-gloss">Three words used above</h2>
        </div>
        <dl className="os-help-gloss">
          {GLOSSARY.map((item) => (
            <div key={item.term}>
              <dt>{item.term}</dt>
              <dd>{item.text}</dd>
            </div>
          ))}
        </dl>
      </section>
    </section>
  );
}
