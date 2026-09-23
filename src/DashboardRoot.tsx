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
import { adminLogin, getAdminSession, getExecutionGateStatus, getLocalAgents, getProductStatus } from "./api";
import { DEMO_BADGE } from "./demo";
import type { LocalAgentRecord } from "./localAgents";
import BlueprintPage from "./pages/BlueprintPage";
import BrainPage from "./pages/BrainPage";
import ChatPage from "./pages/ChatPage";
import GoalsPage from "./pages/GoalsPage";
import HermesPage from "./pages/HermesPage";
import JournalPage from "./pages/JournalPage";
import KanbanPage from "./pages/KanbanPage";
import LoopPage from "./pages/LoopPage";
import DemoBuilderPage from "./pages/DemoBuilderPage";
import MachineControlPage from "./pages/MachineControlPage";
import MemoryPage from "./pages/MemoryPage";
import MissionControlPage from "./pages/MissionControlPage";
import NotebookPage from "./pages/NotebookPage";
import OpenClawPage from "./pages/OpenClawPage";
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

const LEGACY_PAGES = new Set<ShellPage>(["home", "builder", "apis"]);
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
  const [demoPublic, setDemoPublic] = useState(false);
  const [liveChat, setLiveChat] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [adminToken, setAdminToken] = useState("");
  const [loginError, setLoginError] = useState("");

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
    void getProductStatus()
      .then((product) => {
        if (!cancelled) {
          setDemoPublic(Boolean(product.demoPublic));
          setLiveChat(Boolean(product.liveChat));
        }
      })
      .catch(() => {
        if (!cancelled) setDemoPublic(false);
      });
    void getAdminSession()
      .then((session) => {
        if (cancelled) return;
        setAuthRequired(session.required);
        setAuthenticated(session.authenticated);
        setSessionReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setAuthenticated(true);
          setSessionReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionReady || (authRequired && !authenticated)) return;
    let cancelled = false;
    void getProductStatus()
      .then((product) => {
        if (cancelled) return;
        setDemoPublic(Boolean(product.demoPublic));
        setLiveChat(Boolean(product.liveChat));
      })
      .catch(() => undefined);
    void getLocalAgents()
      .then((agents) => {
        if (!cancelled) setLocalAgents(agents);
      })
      .catch(() => undefined);
    void getExecutionGateStatus()
      .then((gate) => {
        if (!cancelled) setDryRun(gate.dryRunDefault !== false && !gate.enabled);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sessionReady, authRequired, authenticated]);

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

  useEffect(() => {
    document.title = demoPublic ? "Agent OS — public demo" : liveChat ? "Agent OS — live" : "Agent OS — local v1";
  }, [demoPublic, liveChat]);

  if (!sessionReady) {
    return (
      <div className="aos-phase2-shell">
        <main className="aos-main"><p className="aos-honest-note">Checking operator session…</p></main>
      </div>
    );
  }

  if (authRequired && !authenticated) {
    return (
      <div className="aos-phase2-shell">
        <main className="aos-main">
          <form
            className="aos-panel"
            onSubmit={(event) => {
              event.preventDefault();
              setLoginError("");
              void adminLogin(adminToken)
                .then((result) => {
                  setAuthenticated(result.session.authenticated);
                  setAuthRequired(result.session.required);
                })
                .catch((caught) => setLoginError(caught instanceof Error ? caught.message : "Admin login failed."));
            }}
          >
            <div className="aos-panel-head">
              <div>
                <span>OPERATOR LOGIN</span>
                <h2>This runtime is locked</h2>
              </div>
            </div>
            <p>Enter the admin token from HERMES_AGENT_OS_ADMIN_TOKEN. It stays in an HttpOnly cookie on this host.</p>
            <label className="aos-field">
              <span>Admin token</span>
              <input type="password" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} autoComplete="current-password" />
            </label>
            {loginError ? <p className="aos-global-error">{loginError}</p> : null}
            <button className="aos-primary" type="submit" disabled={!adminToken.trim()}>Unlock</button>
          </form>
        </main>
      </div>
    );
  }

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
            <span>{demoPublic ? "Public demo" : liveChat ? "Live operator" : "Local v1"}</span>
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
          {demoPublic ? null : (
            <button className={page === "home" ? "active" : ""} onClick={() => go("home")}>
              <Home size={16} /> Workflow studio
            </button>
          )}
          <button className={page === "builder" || (demoPublic && page === "home") ? "active" : ""} onClick={() => go("builder")}>
            <Workflow size={16} /> {demoPublic ? "Demo canvas" : "Agent Builder"}
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
          <span><i className={demoPublic ? "aos-live-dot aos-demo-dot" : "aos-live-dot"} /> {demoPublic ? DEMO_BADGE : liveChat ? "Live chat lane" : dryRun ? "Dry-run default" : "Live execution allowed"}</span>
          <small>{demoPublic ? "Simulated agents · no host shell" : liveChat ? "OmniRoute and native agents · single operator" : "Local only · not a hosted app"}</small>
        </div>
      </aside>
      {menuOpen ? <button className="aos-menu-backdrop" aria-label="Close menu" onClick={() => setMenuOpen(false)} /> : null}
      <div className="aos-phase2-content">
        {page === "mission" ? (
          <MissionControlPage />
        ) : demoPublic && (page === "builder" || page === "home") ? (
          <DemoBuilderPage />
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
        ) : page === "openclaw" ? (
          <OpenClawPage />
        ) : page === "hermes" ? (
          <HermesPage />
        ) : (
          <MachineControlPage />
        )}
      </div>
    </div>
  );
}
