// The New run dialog: one task, one agent, one folder inside the Workspace. Both the Runs page button
// and the ⌘K "New run…" action open this one (the Shell mounts it). It never sends anything it knows will
// be refused: it says why in plain words and points at the fix (Safety, Setup).
import { useEffect, useRef, useState } from "react";
import { getExecutionGateStatus, getWorkspaceListing, listAgents, startAgentRun } from "../../api";
import { navigateTo } from "../../nav";
import type { AgentSummary, ExecutionGateStatus } from "../../types";
import { AGENTS_ORDER, AGENT_LABEL, SETUP_INSTALLED_AGENT_SET, friendlyError } from "../agentsShared";
import { RISKY_STEP_HINT, folderProblem, folderSuggestions, gateBlock, levelWord, pickAgent, startError, taskCount, taskProblem, taskTooLong } from "../newRun";
import type { NewRunRequest } from "../newRun";
import AgentConfirmModal from "./AgentConfirmModal";
import Banner from "./Banner";

export default function NewRunDialog({ request, onClose }: { request: NewRunRequest; onClose: () => void }) {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [agentsFailed, setAgentsFailed] = useState(false);
  const [gate, setGate] = useState<ExecutionGateStatus | null>(null);
  const [gateFailed, setGateFailed] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [task, setTask] = useState(request.prompt || "");
  const [picked, setPicked] = useState(request.agentId || "");
  const [folder, setFolder] = useState("");
  // The "write a task" reason appears only after the person tried to start, so a fresh dialog is not shouting.
  const [triedStart, setTriedStart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [error, setError] = useState<{ text: string; fix?: "safety" | "folder" } | null>(null);
  const taskRef = useRef<HTMLTextAreaElement>(null);

  async function loadAgents(refresh = false) {
    try {
      setAgents((await listAgents(refresh)).agents);
      setAgentsFailed(false);
    } catch {
      setAgentsFailed(true);
    }
  }
  async function loadGate() {
    try {
      setGate(await getExecutionGateStatus());
      setGateFailed(false);
    } catch {
      setGateFailed(true);
    }
  }
  function reload() {
    void loadAgents(true);
    void loadGate();
  }

  useEffect(() => {
    void loadAgents();
    void loadGate();
    // Folder suggestions are a nicety: if the list cannot load, the field still works as plain text.
    getWorkspaceListing()
      .then((listing) => setFolders(folderSuggestions(listing.files)))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `picked` may be an id from a link (?agent=...). pickAgent ignores one it does not know and falls back to
  // the first installed agent, so the select always shows the agent that will actually run.
  const agentId = pickAgent(agents, AGENTS_ORDER, picked);
  const agent = agents?.find((item) => item.id === agentId);
  const label = AGENT_LABEL[agentId] || agentId;
  const installed = agent ? agent.detected.installed : null; // null: not known yet
  const offline = (gate === null && gateFailed) || (agents === null && agentsFailed);
  const block = gateBlock(gate);
  const taskIssue = taskProblem(task);
  const folderIssue = folderProblem(folder);
  const cannotStart = busy || gate === null || agents === null || block !== null || installed !== true || folderIssue !== "";
  // "Write a task" waits for a Start press; "too long" shows at once, because the person is looking at the text.
  const showTaskIssue = taskIssue !== "" && (triedStart || taskTooLong(task));
  const count = taskCount(task);

  function openElsewhere(page: string) {
    onClose();
    navigateTo(page);
  }

  async function recheck() {
    setRechecking(true);
    await loadAgents(true);
    setRechecking(false);
  }

  async function start() {
    if (taskIssue) {
      setTriedStart(true);
      taskRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const run = await startAgentRun(agentId, { prompt: task.trim(), folder: folder.trim() || undefined });
      // Land on the new run's console (D-C3-3). To land on the Board instead, call navigateTo("runs") here.
      navigateTo("runs", { run: run.id });
      onClose();
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : "";
      setError(startError(code) || { text: friendlyError(caught) });
      if (code === "execution_gate_off") void loadGate();
      setBusy(false);
    }
  }

  const level = levelWord(gate);

  return (
    <AgentConfirmModal
      title="New run"
      confirmLabel="Start run"
      confirmDisabled={cannotStart}
      busy={busy}
      wide
      onConfirm={() => void start()}
      onClose={() => (busy ? null : onClose())}
    >
      <p className="os-newrun__lede">A run is one task an agent does on its own.</p>

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
      {block ? (
        <Banner
          tone="warn"
          actions={
            <button type="button" className="os-btn os-btn--secondary" onClick={() => openElsewhere("safety")}>
              Open Safety
            </button>
          }
        >
          {block.text}
        </Banner>
      ) : null}
      {installed === false ? (
        <Banner
          tone="warn"
          title={`${label} isn't installed`}
          actions={
            SETUP_INSTALLED_AGENT_SET.has(agentId) ? (
              <button type="button" className="os-btn os-btn--secondary" onClick={() => openElsewhere("setup")}>
                Open Setup
              </button>
            ) : (
              <>
                <a className="os-btn os-btn--secondary" href={agent?.homepage} target="_blank" rel="noreferrer">
                  Open website
                </a>
                <button type="button" className="os-btn os-btn--ghost" onClick={() => void recheck()} disabled={rechecking}>
                  {rechecking ? "Checking…" : "Re-check"}
                </button>
              </>
            )
          }
        >
          {SETUP_INSTALLED_AGENT_SET.has(agentId) ? "Install it from Setup, then come back." : `Install ${label} from its website, then press Re-check.`}
        </Banner>
      ) : null}

      <div className="os-field">
        <label className="os-field__label" htmlFor="os-newrun-task">
          Task
        </label>
        <textarea
          id="os-newrun-task"
          ref={taskRef}
          rows={4}
          value={task}
          placeholder="For example: Describe this project"
          aria-invalid={showTaskIssue ? true : undefined}
          aria-describedby={count ? "os-newrun-task-note os-newrun-task-count" : "os-newrun-task-note"}
          onChange={(event) => {
            setTask(event.target.value);
            setError(null);
          }}
        />
        <p id="os-newrun-task-note" className={`os-newrun__note${showTaskIssue ? " os-newrun__note--bad" : ""}`} role={showTaskIssue ? "alert" : undefined}>
          {showTaskIssue ? taskIssue : "One clear job. The agent works on it alone and the result lands on this page."}
        </p>
        {count ? (
          <p id="os-newrun-task-count" className={`os-newrun__note${taskTooLong(task) ? " os-newrun__note--bad" : ""}`}>
            {count}
          </p>
        ) : null}
      </div>

      <div className="os-newrun__row">
        <div className="os-field">
          <label className="os-field__label" htmlFor="os-newrun-agent">
            Agent
          </label>
          <select
            id="os-newrun-agent"
            value={agentId}
            disabled={agents === null}
            onChange={(event) => {
              setPicked(event.target.value);
              setError(null);
            }}
          >
            {AGENTS_ORDER.map((id) => {
              const found = agents?.find((item) => item.id === id);
              return (
                <option key={id} value={id}>
                  {AGENT_LABEL[id]}
                  {found && !found.detected.installed ? " (not installed)" : ""}
                </option>
              );
            })}
          </select>
        </div>
        <div className="os-field">
          <label className="os-field__label" htmlFor="os-newrun-folder">
            Folder
          </label>
          <input
            id="os-newrun-folder"
            type="text"
            list="os-newrun-folders"
            value={folder}
            placeholder={`runs-work/${agentId}`}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={folderIssue ? true : undefined}
            aria-describedby="os-newrun-folder-note"
            onChange={(event) => {
              setFolder(event.target.value);
              setError(null);
            }}
          />
          <datalist id="os-newrun-folders">
            {folders.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
      </div>
      <p id="os-newrun-folder-note" className={`os-newrun__note${folderIssue ? " os-newrun__note--bad" : ""}`} role={folderIssue ? "alert" : undefined}>
        {folderIssue || `Runs can only work inside the Workspace. Leave this empty to use runs-work/${agentId}.`}
      </p>

      <p className="os-newrun__hint">
        {level ? `Runs follow your safety level (${level}). ` : "Runs follow your safety level. "}
        {RISKY_STEP_HINT}
      </p>

      {error ? (
        <p className="os-newrun__error" role="alert">
          {error.text}{" "}
          {error.fix === "safety" ? (
            <button type="button" className="os-newrun__link" onClick={() => openElsewhere("safety")}>
              Open Safety
            </button>
          ) : null}
          {error.fix === "folder" ? (
            <button
              type="button"
              className="os-newrun__link"
              onClick={() => {
                setFolder("");
                setError(null);
              }}
            >
              Use the default folder
            </button>
          ) : null}
        </p>
      ) : null}
    </AgentConfirmModal>
  );
}
