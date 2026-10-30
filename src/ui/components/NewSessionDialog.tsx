// The New session dialog: an agent and a folder (the prototype's Home dialog). When a live session already uses the
// folder, it offers a separate copy (a git worktree on a new branch, recommended) or the same folder (spec SP4,
// Worktree offer). The Sessions page (its button and ⌘T), Home, Agents and the palette all open this one: the Shell
// mounts it, like New run. It never sends what it knows will be refused: an agent that isn't installed, no terminal
// module, or the most sessions at once are said in plain words first, and at Look only the Look only note replaces
// the form (decision Q14: a Look only refusal comes before a folder refusal). A folder the server refuses (the
// folder policy, D12) is said under the field, and what was typed stays. The folder comes from the native picker in
// the desktop app, from recent folders, or (in a browser tab, or when the picker fails) as a typed full path.
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Check, FolderOpen, GitFork } from "lucide-react";
import { getExecutionGateStatus, listAgents } from "../../api";
import { navigateTo } from "../../nav";
import { checkFolder, createSession, listSessionFolders, sessionGotNoAnswer } from "../../sessionsApi";
import type { AgentSummary, ExecutionGateStatus, FolderCheck } from "../../types";
import { AGENT_LABEL, AGENT_MAKER, SETUP_CAN_INSTALL_AGENT_SET, collapseHomePath } from "../agentsShared";
import { isDesktopApp } from "../desktop";
import { withTimeout } from "../homeShared";
import {
  FOLDER_EXAMPLE,
  LOOK_ONLY_NOTE,
  OPENCLAW_FOLDER_NOTE,
  OVERWRITE_NOTE,
  RECOMMENDED,
  SAME_FOLDER_LABEL,
  SAME_FOLDER_NOTE,
  SESSION_AGENT_ORDER,
  askToFocusNextSession,
  createdSessionId,
  isLookOnly,
  liveSessionCount,
  maxLiveNote,
  needsFolder,
  peekSessionDraft,
  pickSessionAgent,
  quickStartChoice,
  rememberSessionDraft,
  startProblem,
  typedFolderProblem,
  worktreeOffer
} from "../newSession";
import type { NewSessionRequest, StartProblem } from "../newSession";
import { useSessionsList } from "../useSessionsList";
import AgentConfirmModal from "./AgentConfirmModal";
import Banner from "./Banner";
import "../sessions.css";

// The agents list waits on each agent's own checks (the server gives them about 13 s). The sessions calls
// (createSession, listSessionFolders, and the shared list's own read) carry their own time limits (sessionsApi.ts,
// SESSION_LIMITS_MS: the start waits up to 30 s, for the login-shell environment and the agent's detection).
const AGENTS_TIMEOUT_MS = 15000;
const GATE_TIMEOUT_MS = 10000;
const PTY_WORDS = "Agent OS could not load its terminal module on this computer, so sessions can't start.";
const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
// A typed folder is checked for the worktree offer once typing stops for this long (a picked one at once).
const FOLDER_CHECK_DEBOUNCE_MS = 400;

interface RecentFolder {
  path: string;
  name: string;
}

export default function NewSessionDialog({ request, onClose }: { request: NewSessionRequest; onClose: () => void }) {
  const desktop = isDesktopApp();
  const [draft] = useState(peekSessionDraft);
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [agentsFailed, setAgentsFailed] = useState(false);
  const [gate, setGate] = useState<ExecutionGateStatus | null>(null);
  const [gateFailed, setGateFailed] = useState(false);
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  // The one shared sessions poll (decision Q30): the terminal module and the open sessions, for the limit. The
  // Shell mounts this dialog inside U1's SessionsListProvider.
  const sessionsList = useSessionsList();
  const { refresh: refreshSessions } = sessionsList;
  const [picked, setPicked] = useState(request.agentId || draft?.agentId || "");
  const [folder, setFolder] = useState(draft?.folder || "");
  const [pickerFailed, setPickerFailed] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [problem, setProblem] = useState<StartProblem | null>(null);
  // The worktree offer (spec SP4): the server's folder check for the folder and agent on screen (`key`), and the
  // person's choice between a separate copy and the same folder.
  const [folderCheck, setFolderCheck] = useState<{ key: string; result: FolderCheck | null } | null>(null);
  const [where, setWhere] = useState<"copy" | "same">("copy");
  const alive = useRef(true);
  // Set once a session started: the dialog then leaves the focus alone as it closes (see giveFocusBack below).
  const started = useRef(false);
  const folderRef = useRef<HTMLInputElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);

  async function loadAgents(refresh = false) {
    try {
      const { agents: list } = await withTimeout(listAgents(refresh), AGENTS_TIMEOUT_MS);
      if (!alive.current) return;
      setAgents(Array.isArray(list) ? list : []);
      setAgentsFailed(false);
    } catch {
      if (alive.current) setAgentsFailed(true);
    }
  }
  async function loadGate() {
    try {
      const next = await withTimeout(getExecutionGateStatus(), GATE_TIMEOUT_MS);
      if (!alive.current) return;
      setGate(next);
      setGateFailed(false);
    } catch {
      if (alive.current) setGateFailed(true);
    }
  }
  function reload() {
    void loadAgents(true);
    void loadGate();
  }

  useEffect(() => {
    alive.current = true;
    void loadAgents();
    void loadGate();
    // A fresh read of the shared list, so the limit counts sessions started a moment ago.
    refreshSessions();
    // Recent folders (and the limits below) help, but are not needed: if they can't load, the dialog still
    // works and the server says no to anything it can't do.
    listSessionFolders()
      .then((answer) => {
        if (!alive.current || !answer || !Array.isArray(answer.folders)) return;
        setRecent(answer.folders.filter((item) => item && typeof item.path === "string" && item.path).slice(0, 8));
      })
      .catch(() => undefined);
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The limits from the shared list, only while it is fresh: a stale or missing list blocks nothing here.
  const listBody = sessionsList.source.state === "ok" && !sessionsList.source.stale ? sessionsList.source.data : null;
  const limits =
    listBody && Array.isArray(listBody.sessions)
      ? {
          ptyOk: listBody.pty?.ok !== false,
          ptyReason: listBody.pty?.reason || "",
          live: liveSessionCount(listBody.sessions),
          maxLive: typeof listBody.maxLive === "number" ? listBody.maxLive : 8
        }
      : null;

  // When the native picker could not open, the typed field takes the keyboard.
  useEffect(() => {
    if (pickerFailed) folderRef.current?.focus();
  }, [pickerFailed]);

  // `picked` may be an id from a link; pickSessionAgent ignores one it does not know.
  const agentId = pickSessionAgent(agents, picked);
  const label = AGENT_LABEL[agentId] || agentId;
  const agent = agents?.find((item) => item.id === agentId);
  const installed = agent ? agent.detected.installed : null; // null: not known yet
  const lookOnly = isLookOnly(gate);
  const folderWanted = needsFolder(agentId);
  const typed = !desktop || pickerFailed;
  const typedIssue = folderWanted && typed ? typedFolderProblem(folder) : "";
  const folderIssue = problem?.field === "folder" ? problem.text : typedIssue;
  // Once a folder is known (and sessions can start), the server says which live sessions already use it, whether it
  // is a git project, and the branch a separate copy would get. Start stays on while that check runs: start() waits
  // for the check in flight (`pendingCheck`). Agent OS never makes a separate copy the person did not see offered
  // (quickStartChoice): when the check finds a shared folder and the offer was not on screen yet, nothing starts, the
  // offer is shown with Separate copy picked, and the next Start (or a pick first) decides. A folder nobody else uses
  // starts at once. A check that fails offers nothing, and the session starts in the folder as asked.
  const trimmedFolder = folder.trim();
  const checkKey = folderWanted && trimmedFolder !== "" && typedIssue === "" && lookOnly === false ? `${agentId}\n${trimmedFolder}` : "";
  const checked = folderCheck !== null && folderCheck.key === checkKey ? folderCheck : null;
  const offer = checked ? worktreeOffer(checked.result, agentId) : null;
  const copyOffered = Boolean(offer?.copyLabel);
  // The check in flight for `key` (answers null when it fails or is given up), and what is on screen right now: the
  // answer shown, the key it is for, and the pick (read by start(), whose own render may be out of date by then).
  const pendingCheck = useRef<{ key: string; promise: Promise<FolderCheck | null> } | null>(null);
  const whereRef = useRef<"copy" | "same">("copy");
  whereRef.current = where;
  const checkedRef = useRef<{ key: string; result: FolderCheck | null } | null>(null);
  checkedRef.current = checked;
  const checkKeyRef = useRef("");
  checkKeyRef.current = checkKey;
  useEffect(() => {
    if (!checkKey) {
      pendingCheck.current = null;
      return;
    }
    let current = true;
    const askedFolder = trimmedFolder;
    const askedAgent = agentId;
    let settle: (result: FolderCheck | null) => void = () => undefined;
    const promise = new Promise<FolderCheck | null>((resolve) => {
      settle = resolve;
    });
    pendingCheck.current = { key: checkKey, promise };
    const timer = window.setTimeout(
      () => {
        checkFolder(askedFolder, askedAgent)
          .then((result) => {
            settle(result);
            if (current && alive.current) setFolderCheck({ key: checkKey, result });
          })
          .catch(() => {
            settle(null);
            if (current && alive.current) setFolderCheck({ key: checkKey, result: null });
          });
      },
      typed ? FOLDER_CHECK_DEBOUNCE_MS : 0
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
      // Given up (the folder or the agent changed, or the dialog closed): a Start that waits goes on without an offer.
      settle(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey]);
  // Each new offer starts on the recommended choice (the prototype's).
  const offerKey = copyOffered ? checkKey : "";
  useEffect(() => {
    setWhere("copy");
  }, [offerKey]);
  const full = limits !== null && limits.live >= limits.maxLive;
  const ptyBlocked = limits !== null && !limits.ptyOk;
  const offline = (gate === null && gateFailed) || (agents === null && agentsFailed);
  const checking = (agents === null && !agentsFailed) || (gate === null && !gateFailed);
  const cannotStart =
    busy ||
    gate === null ||
    lookOnly !== false ||
    agents === null ||
    installed !== true ||
    ptyBlocked ||
    full ||
    (folderWanted && (!folder.trim() || typedIssue !== ""));

  function selectAgent(id: string) {
    setPicked(id);
    setProblem(null);
  }
  function onChipKey(event: KeyboardEvent<HTMLButtonElement>) {
    const step = STEP[event.key];
    if (!step) return;
    event.preventDefault();
    const index = SESSION_AGENT_ORDER.indexOf(agentId);
    const next = SESSION_AGENT_ORDER[(index + step + SESSION_AGENT_ORDER.length) % SESSION_AGENT_ORDER.length];
    selectAgent(next);
    chipsRef.current?.querySelector<HTMLButtonElement>(`[data-agent="${next}"]`)?.focus();
  }

  // Closing, or going to Safety or Setup to fix what blocked the start, keeps what was typed (newSession.ts).
  function keepDraft() {
    rememberSessionDraft(folder.trim() ? { agentId, folder } : null);
  }
  function requestClose() {
    if (busy) return;
    keepDraft();
    onClose();
  }
  function openElsewhere(page: string, extra: Record<string, string> = {}) {
    keepDraft();
    onClose();
    navigateTo(page, extra);
  }
  async function recheck() {
    setRechecking(true);
    await loadAgents(true);
    if (alive.current) setRechecking(false);
  }

  async function chooseFolder() {
    setPicking(true);
    setProblem(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      // plugin-dialog 2.8.3: `open<T extends OpenDialogOptions>(options?: T): Promise<OpenDialogReturn<T>>`, which is
      // `string | null` for { directory: true, multiple: false } (null when the person cancels).
      const chosen = await open({ directory: true, multiple: false, title: "Choose a folder for the session" });
      if (!alive.current) return;
      if (typeof chosen === "string" && chosen) setFolder(chosen);
    } catch {
      if (!alive.current) return;
      // No native picker here, or it failed: the dialog offers a typed path instead, so it never dead-ends.
      setPickerFailed(true);
      setProblem({ text: "The folder picker didn't open. Type the folder's full path instead.", field: "folder" });
    } finally {
      if (alive.current) setPicking(false);
    }
  }

  async function start() {
    if (cannotStart) return;
    setBusy(true);
    setProblem(null);
    try {
      // The choice (quickStartChoice): from the offer on screen and the person's pick, or, when the check is still
      // running, from the answer when it comes. A shared folder found that way starts nothing: the offer is shown (its
      // answer is rendered by the check's own effect, with Separate copy picked) and the person decides.
      const onScreen = checkedRef.current;
      const waiting = pendingCheck.current;
      let answer: FolderCheck | null = null;
      if (onScreen === null && waiting && waiting.key === checkKey) {
        answer = await waiting.promise;
        if (!alive.current) return;
        // The folder or the agent changed while Start waited: what was clicked is no longer on screen, so nothing starts.
        if (checkKeyRef.current !== checkKey) {
          setBusy(false);
          return;
        }
      }
      const choice = quickStartChoice(onScreen, answer, agentId, whereRef.current);
      if (choice.action === "show-offer") {
        setBusy(false);
        return;
      }
      const created = await createSession({ agentId, folder: folderWanted ? folder.trim() : null, copy: choice.copy });
      if (!alive.current) return;
      // A 2xx answer that is not a session (`null`, say) is an answer that could not be read, like a body that is
      // not JSON (a SyntaxError, which sessionGotNoAnswer counts as an answer). Nothing is acted on before this check.
      const createdId = createdSessionId(created);
      if (!createdId) throw new SyntaxError("Agent OS answered with something that is not a session.");
      rememberSessionDraft(null);
      // The Start button is gone after this, so the new session's terminal takes the keyboard. Until that terminal
      // exists, no other one does: closing does not hand the focus back to the terminal that was open before.
      started.current = true;
      askToFocusNextSession();
      navigateTo("sessions", { session: createdId });
      onClose();
    } catch (caught) {
      if (!alive.current) return;
      // The words for no answer and for an answer that could not be read differ; src/sessionsApi.ts owns the rule.
      const next = startProblem(caught, sessionGotNoAnswer(caught));
      setProblem(next);
      setBusy(false);
      // No answer, or one that could not be read: the session may have started, so the shared list is read again
      // (the tabs the words point to are then up to date).
      if (!(caught instanceof Error && caught.name === "ApiError")) refreshSessions();
      if (caught instanceof Error && caught.message === "execution_gate_off") void loadGate();
      if (next.field === "folder" && typed) window.requestAnimationFrame(() => folderRef.current?.focus());
    }
  }

  const folderNote = (
    <p
      id="os-newsess-folder-note"
      className={`os-newrun__note${folderIssue ? " os-newrun__note--bad" : ""}`}
      role={folderIssue ? "alert" : undefined}
    >
      {folderIssue || (typed ? FOLDER_EXAMPLE : "A folder inside your home folder.")}
    </p>
  );

  return (
    <AgentConfirmModal
      title="New session"
      confirmLabel="Start session"
      confirmDisabled={cannotStart}
      busy={busy}
      wide
      closeOnBackdrop={false}
      giveFocusBack={() => !started.current}
      onConfirm={() => void start()}
      onClose={requestClose}
    >
      <p className="os-newrun__lede">The agent opens in its own terminal inside Agent OS.</p>

      {offline ? (
        <Banner
          tone="danger"
          title="Agent OS isn't responding"
          actions={
            <button type="button" className="os-btn os-btn--secondary" onClick={reload}>
              Try again
            </button>
          }
        >
          Agent OS can&apos;t check your safety level or your agents right now. Try again in a moment.
        </Banner>
      ) : null}
      {/* Decision Q14: at Look only the note replaces the form; what was picked and typed stays in this dialog. */}
      {lookOnly ? (
        <Banner
          tone="warn"
          actions={
            <a
              className="os-btn os-btn--secondary"
              href="?page=safety"
              onClick={(event) => {
                event.preventDefault();
                openElsewhere("safety");
              }}
            >
              Open Safety
            </a>
          }
        >
          {LOOK_ONLY_NOTE}
        </Banner>
      ) : (
        <>
          {ptyBlocked ? (
            <Banner tone="warn" title="Sessions can't start on this computer">
              {limits?.ptyReason || PTY_WORDS}
            </Banner>
          ) : null}
          {full && limits ? <Banner tone="warn">{maxLiveNote(limits.maxLive)}</Banner> : null}
          {installed === false ? (
            <Banner
              tone="warn"
              title={`${label} isn't installed`}
              actions={
                <>
                  <button type="button" className="os-btn os-btn--secondary" onClick={() => openElsewhere("setup", { step: "plan" })}>
                    Open Setup
                  </button>
                  <button type="button" className="os-btn os-btn--ghost" onClick={() => void recheck()} disabled={rechecking}>
                    {rechecking ? "Checking…" : "Re-check"}
                  </button>
                </>
              }
            >
              {SETUP_CAN_INSTALL_AGENT_SET.has(agentId) ? "Install it from Setup, then come back and press Re-check." : `Install ${label}, then press Re-check.`}
            </Banner>
          ) : null}

          <div className="os-field">
            <span className="os-field__label" id="os-newsess-agent-label">
              Agent
            </span>
            <div ref={chipsRef} className="os-newsess__chips" role="radiogroup" aria-labelledby="os-newsess-agent-label">
              {SESSION_AGENT_ORDER.map((id) => {
                const on = id === agentId;
                const found = agents?.find((item) => item.id === id);
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    data-agent={id}
                    aria-checked={on}
                    tabIndex={on ? 0 : -1}
                    className="os-chip"
                    onClick={() => selectAgent(id)}
                    onKeyDown={onChipKey}
                  >
                    {on ? <Check size={14} aria-hidden="true" /> : null}
                    {AGENT_LABEL[id]}
                    {found && !found.detected.installed ? <span className="os-visually-hidden"> (not installed)</span> : null}
                  </button>
                );
              })}
            </div>
            <p className="os-newrun__note">
              {AGENT_MAKER[agentId] || "—"}
              {installed === false ? " · Not installed" : ""}
            </p>
          </div>

          {!folderWanted ? (
            <div className="os-field">
              <span className="os-field__label">Folder</span>
              <p className="os-newrun__note">{OPENCLAW_FOLDER_NOTE}</p>
            </div>
          ) : typed ? (
            <div className="os-field">
              <label className="os-field__label" htmlFor="os-newsess-folder">
                Folder (full path)
              </label>
              <input
                id="os-newsess-folder"
                ref={folderRef}
                type="text"
                value={folder}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={folderIssue ? true : undefined}
                aria-describedby="os-newsess-folder-note"
                onChange={(event) => {
                  setFolder(event.target.value);
                  setProblem(null);
                }}
              />
              {folderNote}
            </div>
          ) : (
            <div className="os-field">
              <span className="os-field__label" id="os-newsess-folder-label">
                Folder
              </span>
              <div className="os-newsess__pick">
                {folder ? (
                  <code className="os-newsess__path os-mono" title={collapseHomePath(folder)}>
                    {collapseHomePath(folder)}
                  </code>
                ) : (
                  <span className="os-newsess__path os-newsess__path--none">No folder chosen yet</span>
                )}
                <button
                  type="button"
                  className="os-btn os-btn--secondary"
                  onClick={() => void chooseFolder()}
                  disabled={picking}
                  aria-describedby="os-newsess-folder-note"
                >
                  <FolderOpen size={16} aria-hidden="true" />
                  {picking ? "Choosing…" : "Choose folder…"}
                </button>
              </div>
              {folderNote}
            </div>
          )}

          {offer ? (
            <div className="os-field os-newsess__offer">
              <p className="os-newsess__offer-title" id="os-newsess-offer-title">
                <GitFork size={16} aria-hidden="true" />
                <span>{offer.title}</span>
              </p>
              <p className="os-newrun__note">{OVERWRITE_NOTE}</p>
              {offer.copyLabel ? (
                <div className="os-newsess__choices" role="radiogroup" aria-labelledby="os-newsess-offer-title">
                  <label className={`os-newsess__choice${where === "copy" ? " os-newsess__choice--on" : ""}`}>
                    <input
                      type="radio"
                      name="os-newsess-where"
                      value="copy"
                      checked={where === "copy"}
                      disabled={busy}
                      onChange={() => setWhere("copy")}
                    />
                    <span className="os-newsess__choice-body">
                      <span className="os-newsess__choice-line">
                        <strong>{offer.copyLabel}</strong>
                        <span className="os-newsess__tag">{RECOMMENDED}</span>
                      </span>
                      <span>{offer.copyNote}</span>
                    </span>
                  </label>
                  <label className={`os-newsess__choice${where === "same" ? " os-newsess__choice--on" : ""}`}>
                    <input
                      type="radio"
                      name="os-newsess-where"
                      value="same"
                      checked={where === "same"}
                      disabled={busy}
                      onChange={() => setWhere("same")}
                    />
                    <span className="os-newsess__choice-body">
                      <strong>{SAME_FOLDER_LABEL}</strong>
                      <span>{SAME_FOLDER_NOTE}</span>
                    </span>
                  </label>
                </div>
              ) : offer.notGitNote ? (
                <p className="os-newrun__note">{offer.notGitNote}</p>
              ) : null}
            </div>
          ) : null}

          {folderWanted && recent.length ? (
            <div className="os-field">
              <span className="os-field__label" id="os-newsess-recent-label">
                Recent folders
              </span>
              <div className="os-newsess__recent" role="group" aria-labelledby="os-newsess-recent-label">
                {recent.map((item) => {
                  const on = folder.trim() === item.path;
                  return (
                    <button
                      key={item.path}
                      type="button"
                      className="os-chip"
                      aria-pressed={on}
                      title={collapseHomePath(item.path)}
                      onClick={() => {
                        setFolder(item.path);
                        setProblem(null);
                      }}
                    >
                      {on ? <Check size={14} aria-hidden="true" /> : null}
                      <span className="os-newsess__recent-name">{item.name || collapseHomePath(item.path)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {checking ? (
            <p className="os-newrun__hint" role="status">
              Checking your agents and safety level…
            </p>
          ) : (
            <p className="os-newrun__hint">Inside the folder, {label} asks for its own permissions, the same as in your own terminal.</p>
          )}

          {problem && problem.field !== "folder" ? (
            <p className="os-newrun__error" role="alert">
              {problem.text}{" "}
              {problem.fix === "safety" ? (
                <button type="button" className="os-newrun__link" onClick={() => openElsewhere("safety")}>
                  Open Safety
                </button>
              ) : null}
              {problem.fix === "setup" ? (
                <button type="button" className="os-newrun__link" onClick={() => openElsewhere("setup", { step: "plan" })}>
                  Open Setup
                </button>
              ) : null}
              {problem.fix === "sessions" ? (
                <button type="button" className="os-newrun__link" onClick={() => openElsewhere("sessions")}>
                  Open Sessions
                </button>
              ) : null}
            </p>
          ) : null}
        </>
      )}
    </AgentConfirmModal>
  );
}
