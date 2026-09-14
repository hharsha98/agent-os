import { useEffect, useState } from "react";
import {
  Blocks,
  BookOpen,
  Bot,
  Clapperboard,
  Cpu,
  FolderOpen,
  Gauge,
  Home,
  KanbanSquare,
  KeyRound,
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
  Workflow,
} from "lucide-react";
import AgentOSApp from "./AgentOSApp";
import { getExecutionGateStatus, getLocalAgents } from "./api";
import type { LocalAgentRecord } from "./localAgents";
import BlueprintPage from "./pages/BlueprintPage";
import BrainPage from "./pages/BrainPage";
import ChatPage from "./pages/ChatPage";
import GoalsPage from "./pages/GoalsPage";
import JournalPage from "./pages/JournalPage";
import KanbanPage from "./pages/KanbanPage";
import LoopPage from "./pages/LoopPage";
import MachineControlPage from "./pages/MachineControlPage";
import MemoryPage from "./pages/MemoryPage";
import MissionControlPage from "./pages/MissionControlPage";
import NotebookPage from "./pages/NotebookPage";
import SeoPage from "./pages/SeoPage";
import StudioPage from "./pages/StudioPage";
import SwarmPage from "./pages/SwarmPage";
import WorkspacePage from "./pages/WorkspacePage";
import { navigateTo } from "./nav";
import "./phase2.css";

type ShellPage =
  | "mission"
  | "home"
  | "layers"
  | "workspace"
  | "chat"
  | "builder"
  | "apis"
  | "brain"
  | "goals"
  | "kanban"
  | "memory"
  | "notebook"
  | "journal"
  | "loop"
  | "seo"
  | "studio"
  | "swarm"
  | "machine"
  | "openclaw"
  | "hermes";

const LEGACY_PAGES = new Set<ShellPage>(["home", "builder", "apis", "openclaw", "hermes"]);
const ALL_PAGES = new Set<ShellPage>([
  "mission",
  "home",
  "layers",
  "workspace",
  "chat",
  "builder",
  "apis",
  "brain",
  "goals",
  "kanban",
  "memory",
  "notebook",
  "journal",
  "loop",
  "seo",
  "studio",
  "swarm",
  "machine",
  "openclaw",
  "hermes",
]);

function pageFromUrl(): ShellPage {
  const value = new URLSearchParams(window.location.search).get("page");
  if (value && ALL_PAGES.has(value as ShellPage)) return value as ShellPage;
  return "mission";
}

export default function DashboardRoot() {
  const [page, setPage] = useState<ShellPage>(pageFromUrl);
  const [localAgents, setLocalAgents] = useState<LocalAgentRecord[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dryRun, setDryRun] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void getLocalAgents()
      .then((agents) => {
        if (!cancelled) setLocalAgents(agents);
      })
      .catch(() => {
        /* Keep the last honest list instead of wiping to "not installed". */
      });
    void getExecutionGateStatus()
      .then((gate) => {
        if (!cancelled) setDryRun(gate.dryRunDefault !== false && !gate.enabled);
      })
      .catch(() => {
        if (!cancelled) setDryRun(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function sync() {
      setPage(pageFromUrl());
    }
    window.addEventListener("aos-navigate", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("aos-navigate", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  function go(next: ShellPage) {
    navigateTo(next);
    setPage(next);
    setMenuOpen(false);
  }

  return (
    <div className="aos-phase2-shell">
      <button className="aos-icon-button aos-menu-button" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
        <Menu size={18} />
      </button>
      <aside className={`aos-sidebar ${menuOpen ? "is-open" : ""}`}>
        <div className="aos-logo">
          <div className="aos-logo-mark">A</div>
          <div>
            <strong>Agent OS</strong>
            <span>Local v1</span>
          </div>
        </div>
        <nav className="aos-nav">
          <p>Start</p>
          <button className={page === "mission" ? "active" : ""} onClick={() => go("mission")}>
            <Gauge size={16} /> Mission Control
          </button>
          <button className={page === "chat" ? "active" : ""} onClick={() => go("chat")}>
            <MessageSquare size={16} /> Chat
          </button>
          <button className={page === "workspace" ? "active" : ""} onClick={() => go("workspace")}>
            <FolderOpen size={16} /> Workspace
          </button>
          <p>Operate</p>
          <button className={page === "goals" ? "active" : ""} onClick={() => go("goals")}>
            <Target size={16} /> Goals
          </button>
          <button className={page === "kanban" ? "active" : ""} onClick={() => go("kanban")}>
            <KanbanSquare size={16} /> Kanban
          </button>
          <button className={page === "memory" ? "active" : ""} onClick={() => go("memory")}>
            <Blocks size={16} /> Memory
          </button>
          <button className={page === "loop" ? "active" : ""} onClick={() => go("loop")}>
            <Repeat size={16} /> Loop
          </button>
          <button className={page === "notebook" ? "active" : ""} onClick={() => go("notebook")}>
            <NotebookTabs size={16} /> Notebook
          </button>
          <button className={page === "journal" ? "active" : ""} onClick={() => go("journal")}>
            <BookOpen size={16} /> Journal
          </button>
          <p>Build</p>
          <button className={page === "home" ? "active" : ""} onClick={() => go("home")}>
            <Home size={16} /> Workflow studio
          </button>
          <button className={page === "builder" ? "active" : ""} onClick={() => go("builder")}>
            <Workflow size={16} /> Agent Builder
          </button>
          <button className={page === "apis" ? "active" : ""} onClick={() => go("apis")}>
            <KeyRound size={16} /> AI APIs
          </button>
          <p>Labs</p>
          <button className={page === "brain" ? "active" : ""} onClick={() => go("brain")}>
            <Cpu size={16} /> Brain
          </button>
          <button className={page === "layers" ? "active" : ""} onClick={() => go("layers")}>
            <Layers3 size={16} /> Capability map
          </button>
          <button className={page === "seo" ? "active" : ""} onClick={() => go("seo")}>
            <Search size={16} /> SEO
          </button>
          <button className={page === "studio" ? "active" : ""} onClick={() => go("studio")}>
            <Clapperboard size={16} /> Studio
          </button>
          <button className={page === "swarm" ? "active" : ""} onClick={() => go("swarm")}>
            <Network size={16} /> Swarm
          </button>
          <button className={page === "machine" ? "active" : ""} onClick={() => go("machine")}>
            <Monitor size={16} /> Machine Control
          </button>
          <button className={page === "openclaw" ? "active" : ""} onClick={() => go("openclaw")}>
            <Bot size={16} /> OpenClaw
          </button>
          <button className={page === "hermes" ? "active" : ""} onClick={() => go("hermes")}>
            <Sparkles size={16} /> Hermes
          </button>
        </nav>
        <div className="aos-sidebar-foot">
          <span><i className="aos-live-dot" /> {dryRun ? "Dry-run default" : "Live execution allowed"}</span>
          <small>Local only · not a hosted app</small>
        </div>
      </aside>
      {menuOpen ? <button className="aos-menu-backdrop" aria-label="Close menu" onClick={() => setMenuOpen(false)} /> : null}
      <div className="aos-phase2-content">
        {page === "mission" ? (
          <MissionControlPage />
        ) : LEGACY_PAGES.has(page) ? (
          <AgentOSApp key={page} />
        ) : page === "layers" ? (
          <BlueprintPage />
        ) : page === "workspace" ? (
          <WorkspacePage />
        ) : page === "chat" ? (
          <ChatPage localAgents={localAgents} />
        ) : page === "brain" ? (
          <BrainPage />
        ) : page === "goals" ? (
          <GoalsPage localAgents={localAgents} />
        ) : page === "kanban" ? (
          <KanbanPage />
        ) : page === "memory" ? (
          <MemoryPage />
        ) : page === "notebook" ? (
          <NotebookPage />
        ) : page === "journal" ? (
          <JournalPage />
        ) : page === "loop" ? (
          <LoopPage />
        ) : page === "seo" ? (
          <SeoPage />
        ) : page === "studio" ? (
          <StudioPage />
        ) : page === "swarm" ? (
          <SwarmPage />
        ) : (
          <MachineControlPage />
        )}
      </div>
    </div>
  );
}
