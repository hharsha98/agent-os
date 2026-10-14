import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  Activity,
  Blocks,
  Bot,
  ShieldCheck,
  Wand2,
  BookOpen,
  Check,
  Clapperboard,
  ChevronDown,
  Cpu,
  FlaskConical,
  FolderOpen,
  Gauge,
  Home,
  KanbanSquare,
  KeyRound,
  Layers3,
  ListChecks,
  Menu,
  MessageSquare,
  Monitor,
  Network,
  NotebookTabs,
  OctagonX,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Repeat,
  Rows3,
  Search,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Target,
  Users,
  Workflow
} from "lucide-react";
import { getExecutionGateStatus } from "../api";
import CommandPalette from "./components/CommandPalette";
import type { PaletteItem } from "./components/CommandPalette";
import GetStartedPill from "./components/GetStartedPill";
import HoldToStopAll from "./components/HoldToStopAll";
import NewRunDialog from "./components/NewRunDialog";
import StopAllRunsModal from "./components/StopAllRunsModal";
import Toast from "./components/Toast";
import UpdateBanner from "./components/UpdateBanner";
import { useInterval } from "./components/useInterval";
import { OnboardingProvider, useOnboarding } from "./components/useOnboarding";
import { setDensity, useDensity } from "./density";
import Logo from "./Logo";
import { NEW_RUN_EVENT, openNewRun } from "./newRun";
import type { NewRunRequest } from "./newRun";
import { withTimeout } from "./homeShared";
import { revealGetStarted } from "./onboardingShared";
import { levelOf } from "./safetyShared";
import { stopAllMessage } from "./stopAll";

const LABS_STORAGE_KEY = "agentos.labsOpen";
// Same cadence as Home's run polling, so the strip and the page never
// disagree about how many runs are live for more than a moment.
const STATUS_POLL_MS = 5000;
// A server that does not answer must not leave the top bar on "Checking…" for ever.
const STATUS_TIMEOUT_MS = 10000;
const MOBILE_BREAKPOINT = 900;
// At or below this width the sidebar is a 64px icon rail (see shell.css, which
// uses the same number). Between this and MOBILE_BREAKPOINT it can be expanded
// over the page; below MOBILE_BREAKPOINT it is the off-canvas menu as before.
const RAIL_BREAKPOINT = 1366;
const RAIL_QUERY = `(min-width: ${MOBILE_BREAKPOINT + 1}px) and (max-width: ${RAIL_BREAKPOINT}px)`;
// What the palette shortcut is called on this computer.
const SHORTCUT_LABEL = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent || "") ? "⌘K" : "Ctrl K";
// What to call this computer in the menu footer.
const PLATFORM = typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent || "" : "";
const MACHINE_LABEL = /mac/i.test(PLATFORM) ? "On this Mac" : /win/i.test(PLATFORM) ? "On this PC" : "On this computer";

// True while the window is in the rail range; follows resizes.
function useIsRail() {
  const [isRail, setIsRail] = useState(() => window.matchMedia(RAIL_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(RAIL_QUERY);
    function onChange() {
      setIsRail(query.matches);
    }
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return isRail;
}

interface NavItem {
  id: string;
  label: string;
  icon: typeof Home;
  hidden?: boolean;
  // Short trailing text in the menu (for example "4 of 4") and its spoken form.
  meta?: string;
  metaLabel?: string;
  // Shows a tick next to the meta text.
  metaDone?: boolean;
  // Replaces the whole spoken name (otherwise "label, metaLabel").
  ariaLabel?: string;
}

function readLabsPreference(): boolean | null {
  try {
    const raw = window.localStorage.getItem(LABS_STORAGE_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    return null;
  }
}

function writeLabsPreference(open: boolean) {
  try {
    window.localStorage.setItem(LABS_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // localStorage can throw in a locked-down webview; losing the
    // preference is harmless, so this is intentionally swallowed.
  }
}

function machineControlLabel(remainingMs: number | null | undefined) {
  if (!remainingMs || remainingMs <= 0) return "Machine control";
  const minutes = Math.max(1, Math.round(remainingMs / 60000));
  return `Machine control · ${minutes}m left`;
}

interface ShellProps {
  page: string;
  onNavigate: (page: string) => void;
  demoPublic: boolean;
  children: ReactNode;
}

// The "Get started" checklist state is shared by the header pill, the card on
// Home and the palette, so it is provided here, above all of them. (It is not
// asked for in the public demo, where this computer's agents are not the point.)
export default function Shell(props: ShellProps) {
  return (
    <OnboardingProvider enabled={!props.demoPublic}>
      <ShellFrame {...props} />
    </OnboardingProvider>
  );
}

function ShellFrame({ page, onNavigate, demoPublic, children }: ShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [labsOpen, setLabsOpen] = useState(false);
  // The icon rail (901-1366px): collapsed by default, expandable over the page.
  const isRail = useIsRail();
  const [railExpanded, setRailExpanded] = useState(false);
  const [tip, setTip] = useState<{ label: string; top: number } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [stopAllOpen, setStopAllOpen] = useState(false);
  // The New run dialog. The Runs page and the palette ask for it through openNewRun() (src/ui/newRun.ts);
  // the id makes a second request open a fresh dialog.
  const [newRun, setNewRun] = useState<{ id: number; request: NewRunRequest } | null>(null);
  // The result of "Hold to stop all", shown as a toast at the bottom of the window.
  // Each result gets its own id, so a repeated message shows as new (and an ok or
  // neutral one gets a fresh 8 second timer; warnings and failures stay until closed).
  const [toast, setToast] = useState<{ id: number; message: string; tone: "ok" | "warn" | "danger" | "neutral" } | null>(null);
  const density = useDensity();
  const onboarding = useOnboarding();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const railToggleRef = useRef<HTMLButtonElement>(null);
  const firstNavRef = useRef<HTMLButtonElement>(null);

  const onboardingCounts = onboarding.data?.counts;
  // The same rule as the Get started pill: the server counts a skipped step as
  // finished, so "complete" can be true while the count still reads "3 of 4".
  const setupComplete = onboarding.data?.complete === true;
  const coreItems: NavItem[] = useMemo(
    () => [
      { id: "fleet", label: "Home", icon: Home },
      { id: "sessions", label: "Sessions", icon: SquareTerminal },
      { id: "agents", label: "Agents", icon: Bot },
      { id: "runs", label: "Runs", icon: Activity },
      { id: "team", label: "Team Room", icon: Users },
      { id: "workspace", label: "Workspace", icon: FolderOpen },
      {
        id: "setup",
        label: "Setup",
        icon: SlidersHorizontal,
        meta: setupComplete ? "Done" : onboardingCounts ? `${onboardingCounts.done} of ${onboardingCounts.total}` : undefined,
        metaLabel: !setupComplete && onboardingCounts ? `${onboardingCounts.done} of ${onboardingCounts.total} steps done` : undefined,
        metaDone: setupComplete,
        ariaLabel: setupComplete ? "Setup done" : undefined
      },
      { id: "safety", label: "Safety", icon: ShieldCheck }
    ],
    [onboardingCounts, setupComplete]
  );

  const labsItems: NavItem[] = useMemo(
    () => [
      { id: "chat", label: "Dry-run chat", icon: MessageSquare },
      { id: "mission", label: "Mission Control", icon: Gauge },
      { id: "goals", label: "Goals", icon: Target },
      { id: "kanban", label: "Kanban", icon: KanbanSquare },
      { id: "memory", label: "Memory", icon: Blocks },
      { id: "loop", label: "Loop", icon: Repeat },
      { id: "notebook", label: "Notebook", icon: NotebookTabs },
      { id: "journal", label: "Journal", icon: BookOpen },
      { id: "home", label: "Workflow studio", icon: Home, hidden: demoPublic },
      { id: "builder", label: demoPublic ? "Demo canvas" : "Agent Builder", icon: Workflow },
      { id: "apis", label: "AI APIs", icon: KeyRound },
      { id: "brain", label: "Brain", icon: Cpu },
      { id: "layers", label: "Capability map", icon: Layers3 },
      { id: "seo", label: "SEO", icon: Search },
      { id: "studio", label: "Studio", icon: Clapperboard },
      { id: "swarm", label: "Swarm", icon: Network },
      { id: "machine", label: "Machine Control", icon: Monitor },
      { id: "openclaw", label: "OpenClaw", icon: Bot },
      { id: "hermes", label: "Hermes", icon: Sparkles }
    ],
    [demoPublic]
  );

  const labsPageIds = useMemo(() => new Set(labsItems.map((item) => item.id)), [labsItems]);
  const pageIsInLabs = labsPageIds.has(page);

  // Labs starts collapsed unless the operator opened it last time, or the
  // current page lives in Labs (a deep link must never land on a hidden group).
  useEffect(() => {
    const stored = readLabsPreference();
    setLabsOpen(stored ?? false);
  }, []);
  useEffect(() => {
    if (pageIsInLabs) setLabsOpen(true);
  }, [pageIsInLabs]);

  function toggleLabs() {
    setLabsOpen((open) => {
      const next = !open;
      writeLabsPreference(next);
      return next;
    });
  }

  function go(id: string) {
    onNavigate(id);
    setMenuOpen(false);
    setRailExpanded(false);
    setTip(null);
  }

  // The tooltip for a rail icon (its label is hidden there, but kept for screen
  // readers). Only while the rail is collapsed; mouse and keyboard focus both show it.
  function showTip(event: ReactMouseEvent<HTMLElement> | { currentTarget: HTMLElement }, label: string) {
    if (!isRail || railExpanded) return;
    const box = event.currentTarget.getBoundingClientRect();
    setTip({ label, top: box.top + box.height / 2 });
  }

  // The demo canvas renders for both "builder" and (when demoPublic) the
  // hidden legacy "home" page, so "Agent Builder"/"Demo canvas" must read
  // as active for either — matching the pre-Fleet sidebar's behaviour.
  function isActive(id: string) {
    if (id === "builder") return page === "builder" || (demoPublic && page === "home");
    return page === id;
  }

  // Mobile off-canvas: open moves focus to the first nav item, Escape and
  // navigating close it and return focus to the menu button.
  useEffect(() => {
    if (menuOpen) {
      firstNavRef.current?.focus();
    }
  }, [menuOpen]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && menuOpen) {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      } else if (event.key === "Escape" && railExpanded) {
        setRailExpanded(false);
        railToggleRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen, railExpanded]);

  // Leaving the rail range (a wider window) puts the sidebar back to normal.
  useEffect(() => {
    if (!isRail) {
      setRailExpanded(false);
      setTip(null);
    }
  }, [isRail]);

  // ⌘K on a Mac, Ctrl+K elsewhere: open the palette (or close it again).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    function onNewRun(event: Event) {
      setNewRun({ id: Date.now(), request: (event as CustomEvent<NewRunRequest>).detail || {} });
    }
    window.addEventListener(NEW_RUN_EVENT, onNewRun);
    return () => window.removeEventListener(NEW_RUN_EVENT, onNewRun);
  }, []);

  const onboardingData = onboarding.data;
  const setOnboardingHidden = onboarding.setHidden;
  const paletteItems: PaletteItem[] = useMemo(() => {
    const items: PaletteItem[] = [
      { id: "new-run", label: "New run…", group: "Actions", keywords: "launch start agent task prompt", icon: Play, run: () => openNewRun() },
      {
        id: "stop-all",
        label: "Stop all runs",
        group: "Actions",
        hint: "Asks first",
        keywords: "halt kill cancel stop running",
        icon: OctagonX,
        run: () => setStopAllOpen(true)
      },
      { id: "open-setup", label: "Open Setup", group: "Actions", keywords: "install sign in brain assistant", icon: Wand2, run: () => onNavigate("setup") }
    ];
    if (onboardingData) {
      items.push({
        id: "get-started",
        label: "Get started checklist",
        group: "Actions",
        hint: `${onboardingData.counts.done} of ${onboardingData.counts.total} done`,
        keywords: "onboarding first run steps help",
        icon: ListChecks,
        run: () => void revealGetStarted(setOnboardingHidden, onboardingData.hidden)
      });
    }
    items.push(
      {
        id: "density-compact",
        label: "Compact density",
        group: "Actions",
        hint: density === "compact" ? "Current" : "Tighter spacing",
        keywords: "spacing tighter smaller denser",
        icon: Rows3,
        run: () => setDensity("compact")
      },
      {
        id: "density-comfortable",
        label: "Comfortable density",
        group: "Actions",
        hint: density === "comfortable" ? "Current" : "Roomier spacing",
        keywords: "spacing roomier larger looser",
        icon: Rows3,
        run: () => setDensity("comfortable")
      }
    );
    for (const item of coreItems) {
      items.push({ id: `page-${item.id}`, label: item.label, group: "Pages", hint: page === item.id ? "You are here" : undefined, icon: item.icon, run: () => onNavigate(item.id) });
    }
    for (const item of labsItems.filter((entry) => !entry.hidden)) {
      items.push({ id: `page-${item.id}`, label: item.label, group: "Labs", hint: page === item.id ? "You are here" : undefined, icon: item.icon, run: () => onNavigate(item.id) });
    }
    return items;
  }, [onboardingData, setOnboardingHidden, density, coreItems, labsItems, page, onNavigate]);

  const status = useStatusStrip();
  // Hover and focus handlers for one nav button's rail tooltip.
  const tipHandlers = (label: string) => ({
    onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => showTip(event, label),
    onFocus: (event: { currentTarget: HTMLElement }) => showTip(event, label),
    onMouseLeave: () => setTip(null),
    onBlur: () => setTip(null)
  });

  return (
    <div className="aos-phase2-shell os-shell">
      <div className="os-statusbar">
        <button
          ref={menuButtonRef}
          className="os-btn os-btn--ghost os-menu-button"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
        >
          <Menu size={18} />
        </button>
        <button
          type="button"
          className="os-btn os-btn--ghost os-palette-trigger os-palette-trigger--field"
          onClick={() => setPaletteOpen(true)}
          aria-haspopup="dialog"
          aria-label={`Search pages and actions (${SHORTCUT_LABEL})`}
          title={`Search pages and actions (${SHORTCUT_LABEL})`}
        >
          <Search size={14} aria-hidden="true" />
          <span className="os-palette-trigger__text">Search</span>
          <span className="os-kbd" aria-hidden="true">
            {SHORTCUT_LABEL}
          </span>
        </button>
        <span className="os-statusbar__spacer" />
        <GetStartedPill />
        <button type="button" className="os-statusbar__level" onClick={() => go("safety")} title={status.safetyHint || "Open Safety"}>
          <ShieldCheck size={15} aria-hidden="true" />
          <span>
            {status.level === null ? (
              status.safetyLabel
            ) : (
              <>
                <b>Level {status.level}</b> · {safetyLevelLabel(status.level, status.remainingMs)}
              </>
            )}
          </span>
        </button>
        {/* SP4: "Waiting for you (n)" badge, hidden while n = 0 */}
        <HoldToStopAll onResult={(result) => setToast({ id: Date.now(), ...stopAllMessage(result) })} />
      </div>

      <aside className={`os-sidebar${menuOpen ? " is-open" : ""}${railExpanded ? " is-expanded" : ""}`}>
        <div className="os-logo">
          <Logo size={24} className="os-logo__mark" />
          <strong className="os-logo__text os-nav__label">Agent OS</strong>
        </div>
        {/* Only shown in the icon-rail range (shell.css): opens the labels over the page. */}
        <button
          ref={railToggleRef}
          type="button"
          className="os-rail-toggle"
          aria-expanded={railExpanded}
          aria-label={railExpanded ? "Collapse sidebar" : "Expand sidebar"}
          onClick={() => {
            setRailExpanded((open) => !open);
            setTip(null);
          }}
          {...(railExpanded ? {} : tipHandlers("Expand sidebar"))}
        >
          {railExpanded ? <PanelLeftClose size={16} aria-hidden="true" /> : <PanelLeftOpen size={16} aria-hidden="true" />}
          <span className="os-nav__label">{railExpanded ? "Collapse" : "Expand"}</span>
        </button>
        <nav className="os-nav" aria-label="Main">
          {coreItems.map((item, index) => (
            <button
              key={item.id}
              ref={index === 0 ? firstNavRef : undefined}
              className={`os-nav__item${isActive(item.id) ? " is-active" : ""}`}
              aria-current={isActive(item.id) ? "page" : undefined}
              aria-label={item.ariaLabel ?? (item.metaLabel ? `${item.label}, ${item.metaLabel}` : undefined)}
              onClick={() => go(item.id)}
              {...tipHandlers(item.label)}
            >
              <item.icon size={16} aria-hidden="true" /> <span className="os-nav__label">{item.label}</span>
              {item.meta ? (
                <span className="os-nav__meta os-nav__label" aria-hidden="true">
                  {item.metaDone ? <Check size={12} aria-hidden="true" /> : null}
                  {item.meta}
                </span>
              ) : null}
            </button>
          ))}

          <button
            className="os-nav__labs-toggle"
            onClick={toggleLabs}
            aria-expanded={labsOpen}
            aria-label="Labs (experimental)"
            {...tipHandlers("Labs (experimental)")}
          >
            <FlaskConical size={16} aria-hidden="true" />
            <span className="os-micro os-nav__label">Labs</span>
            <ChevronDown size={14} aria-hidden="true" className={`os-nav__chevron${labsOpen ? " is-open" : ""}`} />
          </button>
          {labsOpen ? (
            <div className="os-nav__labs">
              {labsItems
                .filter((item) => !item.hidden)
                .map((item) => (
                  <button
                    key={item.id}
                    className={`os-nav__item${isActive(item.id) ? " is-active" : ""}`}
                    aria-current={isActive(item.id) ? "page" : undefined}
                    onClick={() => go(item.id)}
                    {...tipHandlers(item.label)}
                  >
                    <item.icon size={16} aria-hidden="true" /> <span className="os-nav__label">{item.label}</span>
                  </button>
                ))}
            </div>
          ) : null}
        </nav>
        <div className="os-sidebar__footer" title={demoPublic ? "Public demo" : `Agent OS ${__APP_VERSION__}`}>
          <Monitor size={14} aria-hidden="true" />
          <span className="os-nav__label">{demoPublic ? "Public demo" : MACHINE_LABEL}</span>
          <span className="os-nav__label os-mono os-sidebar__version">v{__APP_VERSION__}</span>
        </div>
      </aside>
      {menuOpen ? <button className="os-menu-backdrop" aria-label="Close menu" onClick={() => setMenuOpen(false)} /> : null}
      {railExpanded ? <button className="os-rail-backdrop" aria-label="Close sidebar" tabIndex={-1} onClick={() => setRailExpanded(false)} /> : null}
      {tip ? (
        <div className="os-rail-tip" role="tooltip" style={{ top: tip.top }}>
          {tip.label}
        </div>
      ) : null}

      <div className="aos-phase2-content os-content" role={pageIsInLabs ? undefined : "main"}>
        {children}
      </div>
      <UpdateBanner />
      {toast ? <Toast key={toast.id} message={toast.message} tone={toast.tone} onClose={() => setToast(null)} /> : null}
      {paletteOpen ? <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} /> : null}
      {stopAllOpen ? <StopAllRunsModal onClose={() => setStopAllOpen(false)} /> : null}
      {newRun ? <NewRunDialog key={newRun.id} request={newRun.request} onClose={() => setNewRun(null)} /> : null}
    </div>
  );
}

function useStatusStrip() {
  const [safetyLabel, setSafetyLabel] = useState("Checking…");
  const [safetyHint, setSafetyHint] = useState("");
  const [level, setLevel] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  async function refresh() {
    try {
      const gate = await withTimeout(getExecutionGateStatus(), STATUS_TIMEOUT_MS);
      const remaining = gate.machineControl?.remainingMs ?? null;
      const armed = Boolean(gate.machineControl?.armed ?? gate.machineControl?.enabled);
      // The same rule as the Safety page (levelOf): an answer that is not a valid shape is
      // unknown, never "Look only". The pill then reads "Safety unknown", like a failed read.
      const known = levelOf(gate, { armed });
      if (known === null) {
        setSafetyLabel("Safety unknown");
        setSafetyHint("Agent OS gave an answer that could not be read.");
        setLevel(null);
        setRemainingMs(null);
        return;
      }
      setSafetyHint(gate.publicSummary || gate.reason || "");
      setLevel(known);
      setRemainingMs(remaining);
    } catch {
      setSafetyLabel("Safety unknown");
      setSafetyHint("Could not reach Agent OS.");
      setLevel(null);
      setRemainingMs(null);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useInterval(() => void refresh(), STATUS_POLL_MS);

  return { safetyLabel, safetyHint, level, remainingMs };
}

// 0 = look only, 1 = run agents, 2 = machine control armed (with its time left).
function safetyLevelLabel(level: number | null, remainingMs: number | null) {
  if (level === 0) return "Look only";
  if (level === 1) return "Run agents";
  if (level === 2) return machineControlLabel(remainingMs);
  return "Checking…";
}

export { MOBILE_BREAKPOINT };
