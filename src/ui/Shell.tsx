import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Blocks,
  Bot,
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
  Menu,
  MessageSquare,
  Monitor,
  Network,
  NotebookTabs,
  Repeat,
  Search,
  Sparkles,
  Target,
  Workflow
} from "lucide-react";
import { getAgentService, getExecutionGateStatus, listRuns } from "../api";
import StatusMark from "./components/StatusMark";
import { useInterval } from "./components/useInterval";

const LABS_STORAGE_KEY = "agentos.labsOpen";
const STATUS_POLL_MS = 10000;
const MOBILE_BREAKPOINT = 900;

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

export default function Shell({
  page,
  onNavigate,
  demoPublic,
  children
}: {
  page: string;
  onNavigate: (page: string) => void;
  demoPublic: boolean;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [labsOpen, setLabsOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const firstNavRef = useRef<HTMLButtonElement>(null);

  const coreItems: NavItem[] = useMemo(
    () => [
      { id: "fleet", label: "Home", icon: LayoutDashboard },
      { id: "chat", label: "Chat", icon: MessageSquare },
      { id: "workspace", label: "Workspace", icon: FolderOpen }
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
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  const status = useStatusStrip();

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
          <span className="os-chip" title={status.safetyHint}>
            <StatusMark kind={status.safetyMark} />
            {status.safetyLabel}
          </span>
          <span className="os-chip" title="Always-on gateways currently running">
            <StatusMark kind={status.gatewaysRunning === null ? "unknown" : status.gatewaysRunning > 0 ? "ok" : "unknown"} />
            Gateways {status.gatewaysRunning === null ? "—" : `${status.gatewaysRunning}/2`}
          </span>
          <span className="os-chip" title="Runs currently in progress">
            <StatusMark
              kind={status.liveRuns === null ? "unknown" : status.liveRuns > 0 ? "live" : "unknown"}
              pulse={false}
            />
            {status.liveRuns === null ? "Live runs —" : `Live runs ${status.liveRuns}`}
          </span>
        </div>
      </div>

      <aside className={`os-sidebar${menuOpen ? " is-open" : ""}`}>
        <div className="os-logo">
          <div className="os-logo-mark">A</div>
          <div>
            <strong>Agent OS</strong>
            <span className="os-micro">{demoPublic ? "Public demo" : "Local v1"}</span>
          </div>
        </div>
        <nav className="os-nav" aria-label="Main">
          <p className="os-micro os-nav__section">Core</p>
          {coreItems.map((item, index) => (
            <button
              key={item.id}
              ref={index === 0 ? firstNavRef : undefined}
              className={`os-nav__item${isActive(item.id) ? " is-active" : ""}`}
              onClick={() => go(item.id)}
            >
              <item.icon size={16} /> {item.label}
            </button>
          ))}

          <button
            className="os-nav__labs-toggle"
            onClick={toggleLabs}
            aria-expanded={labsOpen}
          >
            <FlaskConical size={14} />
            <span className="os-micro">Labs</span>
            <span className="os-chip os-chip--experimental">Experimental</span>
            <ChevronDown size={14} className={`os-nav__chevron${labsOpen ? " is-open" : ""}`} />
          </button>
          {labsOpen ? (
            <div className="os-nav__labs">
              {labsItems
                .filter((item) => !item.hidden)
                .map((item) => (
                  <button
                    key={item.id}
                    className={`os-nav__item${isActive(item.id) ? " is-active" : ""}`}
                    onClick={() => go(item.id)}
                  >
                    <item.icon size={16} /> {item.label}
                  </button>
                ))}
            </div>
          ) : null}
        </nav>
      </aside>
      {menuOpen ? <button className="os-menu-backdrop" aria-label="Close menu" onClick={() => setMenuOpen(false)} /> : null}

      <div className="aos-phase2-content os-content">{children}</div>
    </div>
  );
}

function useStatusStrip() {
  const [safetyLabel, setSafetyLabel] = useState("Checking…");
  const [safetyMark, setSafetyMark] = useState<"unknown" | "ok" | "warn">("unknown");
  const [safetyHint, setSafetyHint] = useState("");
  const [gatewaysRunning, setGatewaysRunning] = useState<number | null>(null);
  const [liveRuns, setLiveRuns] = useState<number | null>(null);

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
    } catch {
      setSafetyLabel("Safety —");
      setSafetyMark("unknown");
      setSafetyHint("Could not reach Agent OS.");
    }

    const results = await Promise.allSettled([getAgentService("hermes"), getAgentService("openclaw")]);
    const running = results.filter((r) => r.status === "fulfilled" && r.value.running).length;
    const anyChecked = results.some((r) => r.status === "fulfilled");
    setGatewaysRunning(anyChecked ? running : null);

    try {
      const { runs } = await listRuns({ limit: 100 });
      setLiveRuns(runs.filter((run) => run.status === "running").length);
    } catch {
      setLiveRuns(null);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useInterval(() => void refresh(), STATUS_POLL_MS);

  return { safetyLabel, safetyMark, safetyHint, gatewaysRunning, liveRuns };
}

export { MOBILE_BREAKPOINT };
