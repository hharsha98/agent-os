import { useEffect, useState } from "react";
import {
  Blocks,
  BookOpen,
  Bot,
  Clapperboard,
  Cpu,
  FolderOpen,
  Home,
  KanbanSquare,
  KeyRound,
  Layers3,
  MessageSquare,
  Monitor,
  NotebookTabs,
  Search,
  Sparkles,
  Target,
  Workflow,
} from "lucide-react";
import AgentOSApp from "./AgentOSApp";
import { getLocalAgents } from "./api";
import BlueprintPage from "./pages/BlueprintPage";
import BrainPage from "./pages/BrainPage";
import ChatPage from "./pages/ChatPage";
import GoalsPage from "./pages/GoalsPage";
import JournalPage from "./pages/JournalPage";
import KanbanPage from "./pages/KanbanPage";
import MachineControlPage from "./pages/MachineControlPage";
import MemoryPage from "./pages/MemoryPage";
import NotebookPage from "./pages/NotebookPage";
import SeoPage from "./pages/SeoPage";
import StudioPage from "./pages/StudioPage";
import WorkspacePage from "./pages/WorkspacePage";
import "./phase2.css";

type LocalAgentStatus = {
  id: string;
  name: string;
  status: string;
  available: boolean;
  version?: string;
  summary?: string;
};

type ShellPage =
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
  | "seo"
  | "studio"
  | "machine"
  | "openclaw"
  | "hermes";

const LEGACY_PAGES = new Set<ShellPage>(["home", "builder", "apis", "openclaw", "hermes"]);
const ALL_PAGES = new Set<ShellPage>([
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
  "seo",
  "studio",
  "machine",
  "openclaw",
  "hermes",
]);

function pageFromUrl(): ShellPage {
  const value = new URLSearchParams(window.location.search).get("page");
  if (value && ALL_PAGES.has(value as ShellPage)) return value as ShellPage;
  return "home";
}

function setPageUrl(page: ShellPage) {
  const next = new URL(window.location.href);
  next.searchParams.set("page", page);
  window.history.replaceState({}, "", next);
}

export default function DashboardRoot() {
  const [page, setPage] = useState<ShellPage>(pageFromUrl);
  const [localAgents, setLocalAgents] = useState<LocalAgentStatus[]>([]);

  useEffect(() => {
    void getLocalAgents()
      .then(setLocalAgents)
      .catch(() => setLocalAgents([]));
  }, []);

  function go(next: ShellPage) {
    setPageUrl(next);
    setPage(next);
  }

  return (
    <div className="aos-phase2-shell">
      <aside className="aos-sidebar">
        <div className="aos-brand">
          <div className="aos-logo">A</div>
          <div>
            <strong>Agent OS</strong>
            <span>Local runtime</span>
          </div>
        </div>
        <nav className="aos-nav">
          <p>Workspace</p>
          <button className={page === "home" ? "active" : ""} onClick={() => go("home")}>
            <Home size={16} /> Home
          </button>
          <button className={page === "layers" ? "active" : ""} onClick={() => go("layers")}>
            <Layers3 size={16} /> 7 Layers
          </button>
          <button className={page === "workspace" ? "active" : ""} onClick={() => go("workspace")}>
            <FolderOpen size={16} /> Workspace
          </button>
          <button className={page === "chat" ? "active" : ""} onClick={() => go("chat")}>
            <MessageSquare size={16} /> Chat
          </button>
          <button className={page === "builder" ? "active" : ""} onClick={() => go("builder")}>
            <Workflow size={16} /> Agent Builder
          </button>
          <button className={page === "apis" ? "active" : ""} onClick={() => go("apis")}>
            <KeyRound size={16} /> AI APIs
          </button>
          <p>Operate</p>
          <button className={page === "brain" ? "active" : ""} onClick={() => go("brain")}>
            <Cpu size={16} /> Brain
          </button>
          <button className={page === "goals" ? "active" : ""} onClick={() => go("goals")}>
            <Target size={16} /> Goals
          </button>
          <button className={page === "kanban" ? "active" : ""} onClick={() => go("kanban")}>
            <KanbanSquare size={16} /> Kanban
          </button>
          <button className={page === "memory" ? "active" : ""} onClick={() => go("memory")}>
            <Blocks size={16} /> Memory
          </button>
          <button className={page === "notebook" ? "active" : ""} onClick={() => go("notebook")}>
            <NotebookTabs size={16} /> Notebook
          </button>
          <button className={page === "journal" ? "active" : ""} onClick={() => go("journal")}>
            <BookOpen size={16} /> Journal
          </button>
          <button className={page === "seo" ? "active" : ""} onClick={() => go("seo")}>
            <Search size={16} /> SEO
          </button>
          <button className={page === "studio" ? "active" : ""} onClick={() => go("studio")}>
            <Clapperboard size={16} /> Studio
          </button>
          <button className={page === "machine" ? "active" : ""} onClick={() => go("machine")}>
            <Monitor size={16} /> Machine Control
          </button>
          <p>Agents</p>
          <button className={page === "openclaw" ? "active" : ""} onClick={() => go("openclaw")}>
            <Bot size={16} /> OpenClaw
          </button>
          <button className={page === "hermes" ? "active" : ""} onClick={() => go("hermes")}>
            <Sparkles size={16} /> Hermes
          </button>
        </nav>
      </aside>
      <div className="aos-phase2-content">
        {LEGACY_PAGES.has(page) ? (
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
        ) : page === "seo" ? (
          <SeoPage />
        ) : page === "studio" ? (
          <StudioPage />
        ) : (
          <MachineControlPage />
        )}
      </div>
    </div>
  );
}
