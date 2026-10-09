import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  Activity,
  Blocks,
  Bot,
  Boxes,
  ShieldCheck,
  Wand2,
  BookOpen,
  Clapperboard,
  ChevronDown,
  Cpu,
  FlaskConical,
  FolderOpen,
  Gauge,
  Home,
  KanbanSquare,
  KeyRound,
  LayoutDashboard,
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
  Sparkles,
  Target,
  Users,
  Workflow
} from "lucide-react";
import { getAgentService, getExecutionGateStatus, listRuns } from "../api";
import { navigateTo } from "../nav";
import CommandPalette from "./components/CommandPalette";
import type { PaletteItem } from "./components/CommandPalette";
import GetStartedPill from "./components/GetStartedPill";
import StatusMark from "./components/StatusMark";
import StopAllRunsModal from "./components/StopAllRunsModal";
import UpdateBanner from "./components/UpdateBanner";
import { useInterval } from "./components/useInterval";
import { OnboardingProvider, useOnboarding } from "./components/useOnboarding";
import { setDensity, useDensity } from "./density";
import { revealGetStarted } from "./onboardingShared";

const LABS_STORAGE_KEY = "agentos.labsOpen";
// Same cadence as Home's run polling, so the strip and the page never
// disagree about how many runs are live for more than a moment.
const STATUS_POLL_MS = 5000;
const MOBILE_BREAKPOINT = 900;
// At or below this width the sidebar is a 64px icon rail (see shell.css, which
// uses the same number). Between this and MOBILE_BREAKPOINT it can be expanded
// over the page; below MOBILE_BREAKPOINT it is the off-canvas menu as before.
const RAIL_BREAKPOINT = 1366;
const RAIL_QUERY = `(min-width: ${MOBILE_BREAKPOINT + 1}px) and (max-width: ${RAIL_BREAKPOINT}px)`;
// What the palette shortcut is called on this computer.
const SHORTCUT_LABEL = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent || "") ? "⌘K" : "Ctrl K";

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
  const density = useDensity();
  const onboarding = useOnboarding();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const railToggleRef = useRef<HTMLButtonElement>(null);
  const firstNavRef = useRef<HTMLButtonElement>(null);

  const coreItems: NavItem[] = useMemo(
    () => [
      { id: "fleet", label: "Home", icon: LayoutDashboard },
      { id: "agents", label: "Agents", icon: Boxes },
      { id: "runs", label: "Runs", icon: Activity },
      { id: "team", label: "Team Room", icon: Users },
      { id: "chat", label: "Chat", icon: MessageSquare },
      { id: "workspace", label: "Workspace", icon: FolderOpen },
      { id: "setup", label: "Setup", icon: Wand2 },
      { id: "safety", label: "Safety", icon: ShieldCheck }
    ],
    []
  );

  const labsItems: NavItem[] = useMemo(
    () => [
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

  const onboardingData = onboarding.data;
  const setOnboardingHidden = onboarding.setHidden;
  const paletteItems: PaletteItem[] = useMemo(() => {
    const items: PaletteItem[] = [
      { id: "new-run", label: "New run…", group: "Actions", keywords: "launch start agent task prompt", icon: Play, run: () => navigateTo("agents") },
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
        <div className="os-statusbar__chips">
          <GetStartedPill />
          <button
            type="button"
            className="os-btn os-btn--ghost os-palette-trigger"
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
          <div className="os-density" role="group" aria-label="Density">
            <button type="button" aria-pressed={density === "comfortable"} onClick={() => setDensity("comfortable")}>
              Comfortable
            </button>
            <button type="button" aria-pressed={density === "compact"} onClick={() => setDensity("compact")}>
              Compact
            </button>
          </div>
          <div className="os-statusbar__group">
            <span className="os-statusbar__seg" title={status.safetyHint}>
              <StatusMark kind={status.safetyMark} />
              <span className="os-statusbar__seg-value">{status.safetyLabel}</span>
            </span>
            <span className="os-statusbar__seg" title="Always-on gateways currently running">
              <StatusMark
                kind={!status.gatewaysLoaded || status.gatewaysRunning === null ? "unknown" : status.gatewaysRunning > 0 ? "ok" : "unknown"}
              />
              <span className="os-statusbar__seg-value">
                Gateways {!status.gatewaysLoaded ? "…" : status.gatewaysRunning === null ? "—" : `${status.gatewaysRunning}/2`}
              </span>
            </span>
            <span className="os-statusbar__seg" title="Runs currently in progress">
              <StatusMark
                kind={!status.liveRunsLoaded || status.liveRuns === null ? "unknown" : status.liveRuns > 0 ? "live" : "unknown"}
                pulse={false}
              />
              <span className="os-statusbar__seg-value">
                Live runs {!status.liveRunsLoaded ? "…" : status.liveRuns === null ? "—" : status.liveRuns}
              </span>
            </span>
          </div>
        </div>
      </div>

      <aside className={`os-sidebar${menuOpen ? " is-open" : ""}${railExpanded ? " is-expanded" : ""}`}>
        <div className="os-logo">
          <div className="os-logo-mark">A</div>
          <div className="os-logo__text">
            <strong>Agent OS</strong>
            <span className="os-micro os-mono">{demoPublic ? "Public demo" : "v0.3 · local"}</span>
          </div>
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
          <p className="os-micro os-nav__section">Core</p>
          {coreItems.map((item, index) => (
            <button
              key={item.id}
              ref={index === 0 ? firstNavRef : undefined}
              className={`os-nav__item${isActive(item.id) ? " is-active" : ""}`}
              aria-current={isActive(item.id) ? "page" : undefined}
              onClick={() => go(item.id)}
              {...tipHandlers(item.label)}
            >
              <item.icon size={16} aria-hidden="true" /> <span className="os-nav__label">{item.label}</span>
            </button>
          ))}

          <button
            className="os-nav__labs-toggle"
            onClick={toggleLabs}
            aria-expanded={labsOpen}
            aria-label="Labs (experimental)"
            {...tipHandlers("Labs (experimental)")}
          >
            <FlaskConical size={14} aria-hidden="true" />
            <span className="os-micro os-nav__label">Labs</span>
            <span className="os-chip os-chip--experimental os-nav__label">Experimental</span>
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
        <button
          className="os-sidebar__safety"
          onClick={() => go("safety")}
          title={status.safetyHint || "Open Safety"}
          {...tipHandlers(status.level === null ? status.safetyLabel : safetyLevelLabel(status.level))}
        >
          {/* Falls back to the top strip's own label/mark when the level is
              unknown, so "still loading" and "checked, but unreachable" read
              distinctly here too — same as the strip above. */}
          <StatusMark kind={status.level === null ? status.safetyMark : safetyLevelMark(status.level)} />
          <span className="os-nav__label">{status.level === null ? status.safetyLabel : safetyLevelLabel(status.level)}</span>
        </button>
      </aside>
      {menuOpen ? <button className="os-menu-backdrop" aria-label="Close menu" onClick={() => setMenuOpen(false)} /> : null}
      {railExpanded ? <button className="os-rail-backdrop" aria-label="Close sidebar" tabIndex={-1} onClick={() => setRailExpanded(false)} /> : null}
      {tip ? (
        <div className="os-rail-tip" role="tooltip" style={{ top: tip.top }}>
          {tip.label}
        </div>
      ) : null}

      <div className="aos-phase2-content os-content">{children}</div>
      <UpdateBanner />
      {paletteOpen ? <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} /> : null}
      {stopAllOpen ? <StopAllRunsModal onClose={() => setStopAllOpen(false)} /> : null}
    </div>
  );
}

function useStatusStrip() {
  const [safetyLabel, setSafetyLabel] = useState("Checking…");
  const [safetyMark, setSafetyMark] = useState<"unknown" | "ok" | "warn">("unknown");
  const [safetyHint, setSafetyHint] = useState("");
  const [level, setLevel] = useState<number | null>(null);
  const [gatewaysRunning, setGatewaysRunning] = useState<number | null>(null);
  const [gatewaysLoaded, setGatewaysLoaded] = useState(false);
  const [liveRuns, setLiveRuns] = useState<number | null>(null);
  const [liveRunsLoaded, setLiveRunsLoaded] = useState(false);

  async function refresh() {
    try {
      const gate = await getExecutionGateStatus();
      const remainingMs = gate.machineControl?.remainingMs ?? null;
      const armed = Boolean(gate.machineControl?.armed ?? gate.machineControl?.enabled);
      if (armed) {
        setSafetyLabel(machineControlLabel(remainingMs));
        setSafetyMark("warn");
      } else {
        setSafetyLabel(gate.enabled ? "Run agents" : "Look only");
        setSafetyMark(gate.enabled ? "ok" : "unknown");
      }
      setSafetyHint(gate.publicSummary || gate.reason || "");
      setLevel(typeof gate.level === "number" ? gate.level : armed ? 2 : gate.enabled ? 1 : 0);
    } catch {
      setSafetyLabel("Safety —");
      setSafetyMark("unknown");
      setSafetyHint("Could not reach Agent OS.");
      setLevel(null);
    }

    const results = await Promise.allSettled([getAgentService("hermes"), getAgentService("openclaw")]);
    const running = results.filter((r) => r.status === "fulfilled" && r.value.running).length;
    const anyChecked = results.some((r) => r.status === "fulfilled");
    setGatewaysRunning(anyChecked ? running : null);
    setGatewaysLoaded(true);

    try {
      const { runs } = await listRuns({ limit: 100 });
      setLiveRuns(runs.filter((run) => run.status === "running").length);
    } catch {
      setLiveRuns(null);
    }
    setLiveRunsLoaded(true);
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useInterval(() => void refresh(), STATUS_POLL_MS);

  return { safetyLabel, safetyMark, safetyHint, level, gatewaysRunning, gatewaysLoaded, liveRuns, liveRunsLoaded };
}

// 0 = look only, 1 = run agents, 2 = machine control armed. Shape+colour,
// never colour alone, and "—"-equivalent (a hollow ring) only while the
// level genuinely hasn't been checked yet.
function safetyLevelMark(level: number | null): "unknown" | "ok" | "warn" {
  if (level === 1) return "ok";
  if (level === 2) return "warn";
  return "unknown";
}
function safetyLevelLabel(level: number | null) {
  if (level === 0) return "Look only";
  if (level === 1) return "Run agents";
  if (level === 2) return "Machine control";
  return "Checking…";
}

export { MOBILE_BREAKPOINT };
