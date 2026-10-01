// The "AI brain" step: choose a model provider for Hermes/OpenClaw. Two
// option cards (free OpenRouter key, or a local Ollama model) plus a
// "Choose for me" shortcut that picks the server's own recommendation.
// The OpenRouter key lives only in this component's state until it's
// verified and handed to onApply -- never logged, never in a URL, never in
// localStorage, and the parent bumps `resetToken` right after POST
// /configure returns so the field is wiped whether that call worked or not.
import { useEffect, useState } from "react";
import { AlertTriangle, ExternalLink } from "lucide-react";
import StatusMark from "./StatusMark";
import type { BrainOptionsResponse, OpenRouterModel } from "../../setupApi";
import { getOpenRouterModels, isLikelySmallModel, verifyOpenRouterKey } from "../../setupApi";

export type BrainSelection = { mode: "openrouter" | "ollama"; model: string; apiKey?: string };

export interface BrainAgentLine {
  id: string;
  label: string;
  installed: boolean;
  configured: boolean;
}

const MODE_LABEL = { openrouter: "Free OpenRouter key", ollama: "Local model (Ollama)" } as const;

export default function SetupBrainPanel({
  brain,
  agents,
  onApply,
  busy,
  error,
  resetToken
}: {
  brain: BrainOptionsResponse;
  agents: BrainAgentLine[];
  onApply: (selection: BrainSelection) => void;
  busy?: boolean;
  error?: string;
  resetToken: number;
}) {
  const [mode, setMode] = useState<"openrouter" | "ollama" | null>(null);
  const [pickedForYou, setPickedForYou] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<"idle" | "checking" | "ok" | "error">("idle");
  const [keyMessage, setKeyMessage] = useState("");
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [modelsError, setModelsError] = useState("");
  const [modelsAttempt, setModelsAttempt] = useState(0);
  const [selectedModel, setSelectedModel] = useState("");
  const [ollamaModel, setOllamaModel] = useState("");

  const ollamaOption = brain.options.find((o) => o.id === "ollama");

  // The parent bumps this right after POST /configure returns: drop the key
  // and make the person verify again rather than keep a secret around.
  useEffect(() => {
    if (resetToken === 0) return;
    setApiKey("");
    setKeyStatus("idle");
    setKeyMessage("");
  }, [resetToken]);

  useEffect(() => {
    if (mode !== "openrouter" || models.length) return;
    let cancelled = false;
    setModelsError("");
    getOpenRouterModels()
      .then((res) => {
        if (cancelled) return;
        setModels(res.models);
        if (res.error) setModelsError(res.error);
        else if (!res.models.length) setModelsError("OpenRouter has no free models that fit right now.");
      })
      .catch(() => {
        if (!cancelled) setModelsError("Could not load OpenRouter's model list.");
      });
    return () => {
      cancelled = true;
    };
    // modelsAttempt is the "Try again" button
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, modelsAttempt]);

  async function checkKey() {
    if (!apiKey.trim() || keyStatus === "checking") return;
    setKeyStatus("checking");
    setKeyMessage("");
    try {
      const result = await verifyOpenRouterKey(apiKey);
      if (result.ok) {
        setKeyStatus("ok");
        setKeyMessage(result.label ? `Key looks good (${result.label}).` : "Key looks good.");
      } else {
        setKeyStatus("error");
        setKeyMessage(result.error || "That key didn't check out.");
      }
    } catch {
      setKeyStatus("error");
      setKeyMessage("Could not reach OpenRouter to verify the key.");
    }
  }

  function chooseForMe() {
    setMode(brain.recommendation);
    setPickedForYou(true);
  }

  const ollamaSmallWarning = Boolean(ollamaModel && isLikelySmallModel(ollamaModel));

  function handleApply() {
    if (mode === "openrouter") {
      if (keyStatus !== "ok" || !selectedModel) return;
      onApply({ mode: "openrouter", model: selectedModel, apiKey });
    } else if (mode === "ollama") {
      if (!ollamaModel.trim()) return;
      onApply({ mode: "ollama", model: ollamaModel.trim() });
    }
  }

  const canApply =
    (mode === "openrouter" && keyStatus === "ok" && Boolean(selectedModel)) ||
    (mode === "ollama" && Boolean(ollamaModel.trim()));

  return (
    <div className="os-setup-brain">
      <div className="os-setup-brain__intro">
        <p>{brain.reason}</p>
        <button type="button" className="os-btn os-btn--secondary" onClick={chooseForMe}>
          Choose for me
        </button>
      </div>
      <p className="os-setup-brain__picked" role="status">
        {pickedForYou && mode ? `Picked for you: ${MODE_LABEL[mode]} (the option we recommend).` : ""}
      </p>

      <ul className="os-setup-brain__agents" aria-label="Agents this applies to">
        {agents.map((a) => (
          <li key={a.id}>
            <StatusMark kind={!a.installed ? "unknown" : a.configured ? "ok" : "warn"} />
            <span>
              <strong>{a.label}</strong>:{" "}
              {!a.installed ? "not installed, so nothing to set up" : a.configured ? "already has a model (kept as it is)" : "needs a model"}
            </span>
          </li>
        ))}
      </ul>

      {error ? (
        <p className="os-setup-brain__error" role="alert">
          <AlertTriangle size={14} /> {error}
        </p>
      ) : null}

      <div className="os-setup-brain__cards">
        <div className={`os-panel os-setup-brain__card ${mode === "openrouter" ? "os-setup-brain__card--selected" : ""}`}>
          <header>
            <label className="os-setup-brain__card-select">
              <input type="radio" name="brain-mode" checked={mode === "openrouter"} onChange={() => {
                  setMode("openrouter");
                  setPickedForYou(false);
                }} />
              <strong>{MODE_LABEL.openrouter}</strong>
            </label>
            {brain.recommendation === "openrouter" ? <span className="os-chip">Recommended</span> : null}
          </header>
          <p className="os-setup-brain__tradeoff">Free, strong models, no download — but your messages go to a cloud provider.</p>
          {mode === "openrouter" ? (
            <div className="os-setup-brain__card-body">
              <ol className="os-setup-brain__guide">
                <li>
                  Go to{" "}
                  <a href="https://openrouter.ai" target="_blank" rel="noreferrer">
                    openrouter.ai <ExternalLink size={12} />
                  </a>{" "}
                  and sign up (free).
                </li>
                <li>Create an API key from your dashboard.</li>
                <li>Paste it below.</li>
              </ol>
              <label className="os-field">
                <span className="os-field__label">OpenRouter API key</span>
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setKeyStatus("idle");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void checkKey();
                    }
                  }}
                />
              </label>
              <div className="os-setup-brain__key-row">
                <button type="button" className="os-btn os-btn--secondary" onClick={checkKey} disabled={!apiKey.trim() || keyStatus === "checking"}>
                  {keyStatus === "checking" ? "Checking…" : "Check key"}
                </button>
                {keyStatus !== "idle" ? (
                  <span className="os-setup-brain__key-status" role="status">
                    <StatusMark kind={keyStatus === "ok" ? "ok" : keyStatus === "checking" ? "unknown" : "error"} />
                    {keyStatus === "checking" ? "Checking…" : keyMessage}
                  </span>
                ) : null}
              </div>
              {modelsError ? (
                <p className="os-setup-brain__error">
                  {modelsError}{" "}
                  <button type="button" className="os-btn os-btn--ghost" onClick={() => setModelsAttempt((n) => n + 1)}>
                    Try again
                  </button>
                </p>
              ) : null}
              <label className="os-field">
                <span className="os-field__label">Model</span>
                <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} disabled={!models.length}>
                  <option value="">{models.length ? "Choose a model" : modelsError ? "No models available" : "Loading models…"}</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="os-setup-brain__privacy">Your key goes straight into each agent's own settings. Agent OS doesn't keep a copy.</p>
            </div>
          ) : null}
        </div>

        <div className={`os-panel os-setup-brain__card ${mode === "ollama" ? "os-setup-brain__card--selected" : ""}`}>
          <header>
            <label className="os-setup-brain__card-select">
              <input
                type="radio"
                name="brain-mode"
                checked={mode === "ollama"}
                onChange={() => {
                  setMode("ollama");
                  setPickedForYou(false);
                }}
                disabled={!ollamaOption?.available}
              />
              <strong>{MODE_LABEL.ollama}</strong>
            </label>
            <span className="os-setup-brain__card-badges">
              {brain.recommendation === "ollama" ? <span className="os-chip">Recommended</span> : null}
              <span className="os-setup-brain__avail">
                <StatusMark kind={ollamaOption?.available ? "ok" : "unknown"} />
                {ollamaOption?.available ? "Available" : "Not available"}
              </span>
            </span>
          </header>
          <p className="os-setup-brain__tradeoff">Private and free once downloaded — but needs disk space and is usually lower quality.</p>
          {!ollamaOption?.available ? (
            <p className="os-setup-brain__note">{ollamaOption?.reason || "Ollama is not available on this computer."}</p>
          ) : null}
          {mode === "ollama" && ollamaOption?.available ? (
            <div className="os-setup-brain__card-body">
              <label className="os-field">
                <span className="os-field__label">Model you already downloaded in Ollama</span>
                <input
                  type="text"
                  placeholder="e.g. llama3.1:8b"
                  value={ollamaModel}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setOllamaModel(e.target.value)}
                />
              </label>
              <p className="os-setup-brain__privacy">Type the name exactly as the "ollama list" command shows it. Agent OS checks it is really there before using it.</p>
              {ollamaSmallWarning ? (
                <p className="os-setup-brain__warning">
                  Small models often give poor answers for agent tasks. For better results pick a bigger model or use OpenRouter.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <button type="button" className="os-btn os-btn--primary os-setup-brain__apply" onClick={handleApply} disabled={!canApply || busy}>
        Apply
      </button>
      {!canApply ? (
        <p className="os-setup-brain__privacy">
          {mode === null
            ? "Pick an option above to continue."
            : mode === "openrouter"
              ? "Check your key and choose a model to continue."
              : "Enter the model name to continue."}
        </p>
      ) : null}
    </div>
  );
}
