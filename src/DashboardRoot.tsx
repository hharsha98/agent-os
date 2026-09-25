import { useEffect, useState } from "react";
import AgentOSApp from "./AgentOSApp";
import { adminLogin, getAdminSession, getLocalAgents, getProductStatus } from "./api";
import type { LocalAgentRecord } from "./localAgents";
import LockedScreen from "./LockedScreen";
import BlueprintPage from "./pages/BlueprintPage";
import BrainPage from "./pages/BrainPage";
import ChatPage from "./pages/ChatPage";
import FleetPage from "./pages/FleetPage";
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
import Shell from "./ui/Shell";
import "./phase2.css";
import "./ui/fonts";
import "./ui/tokens.css";
import "./ui/base.css";
import "./ui/shell.css";

type ShellPage =
  | "fleet"
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
  "fleet",
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
  return "fleet";
}

export default function DashboardRoot() {
  const [page, setPage] = useState<ShellPage>(pageFromUrl);
  const [localAgents, setLocalAgents] = useState<LocalAgentRecord[]>([]);
  const [demoPublic, setDemoPublic] = useState(false);
  const [liveChat, setLiveChat] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [adminToken, setAdminToken] = useState("");
  const [loginError, setLoginError] = useState("");
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    function onLocked() {
      setLocked(true);
    }
    window.addEventListener("agentos:locked", onLocked);
    return () => {
      window.removeEventListener("agentos:locked", onLocked);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getLocalAgents()
      .then((agents) => {
        if (!cancelled) setLocalAgents(agents);
      })
      .catch(() => {
        /* Keep the last honest list instead of wiping to "not installed". */
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

  if (locked) {
    return <LockedScreen />;
  }

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
  }

  return (
    <Shell page={page} onNavigate={(next) => go(next as ShellPage)} demoPublic={demoPublic}>
      {page === "fleet" ? (
        <FleetPage />
      ) : page === "mission" ? (
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
    </Shell>
  );
}
