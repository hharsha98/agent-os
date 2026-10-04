// "Choose on OpenRouter's website": the other way to pick a model. Two paths,
// so it works even if presets don't:
//   1. Browse models on OpenRouter, copy a model's ID, paste it here. It is
//      looked up on OpenRouter first (name, price, context), then given to the
//      agents exactly like a model from the picker.
//   2. Presets (beta): build a preset on OpenRouter, type its name here, and the
//      agents follow it. OpenRouter never tells an app which preset was picked,
//      so the name is typed, and a green tick only appears after the agent
//      really answered a hello through the preset.
import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import ModelApplyPanel from "./ModelApplyPanel";
import StatusMark from "./StatusMark";
import type { AgentModelInfo, BrainAgentId, CatalogModel, OpenPageResult } from "../../setupApi";
import { cancelOpenRouterConnect, friendlyError, lookupOpenRouterModel, openOpenRouterModels, openOpenRouterPresets } from "../../setupApi";
import { agentApplier, buildAgentTargets } from "../agentModelChange";
import type { BrainAgentLine } from "../brainShared";
import type { ApplySubject } from "../modelPickerShared";
import { costNote, formatTokens, modelIdFromPaste } from "../modelPickerShared";
import "../modelPicker.css";

// The same rule the server uses for a preset's name.
const PRESET_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export default function OpenRouterWebsitePanel({
  agents,
  models,
  initialAgents,
  onChanged,
  onClose
}: {
  agents: BrainAgentLine[];
  models: Partial<Record<BrainAgentId, AgentModelInfo | null>>;
  initialAgents?: BrainAgentId[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const targets = useMemo(() => buildAgentTargets(agents, models), [agents, models]);
  const apply = useMemo(() => agentApplier(agents), [agents]);
  // One OpenRouter connection, shared by both paths (only one is applied at a time).
  const [flowId, setFlowId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openNote, setOpenNote] = useState<{ text: string; url?: string } | null>(null);

  // An unused connection is forgotten on the server when this panel closes.
  const flowRef = useRef<string | null>(null);
  flowRef.current = flowId;
  useEffect(() => {
    return () => {
      if (flowRef.current) void cancelOpenRouterConnect(flowRef.current).catch(() => undefined);
    };
  }, []);

  // path 1
  const [pasted, setPasted] = useState("");
  const [lookup, setLookup] = useState<"idle" | "looking" | "error">("idle");
  const [lookupError, setLookupError] = useState("");
  const [found, setFound] = useState<CatalogModel | null>(null);

  // path 2
  const [slugText, setSlugText] = useState("");
  const slug = slugText.trim();
  const slugOk = PRESET_SLUG.test(slug);

  async function open(action: () => Promise<OpenPageResult>) {
    setOpenNote(null);
    try {
      const result = await action();
      if (!result.opened) setOpenNote({ text: "Couldn't open your browser by itself. Open this page:", url: result.url });
    } catch (error) {
      setOpenNote({ text: friendlyError(error, "Couldn't open OpenRouter's page.") });
    }
  }

  async function lookUp() {
    const id = modelIdFromPaste(pasted);
    if (!id || lookup === "looking") return;
    setLookup("looking");
    setLookupError("");
    setFound(null);
    try {
      setFound((await lookupOpenRouterModel(id)).model);
      setLookup("idle");
    } catch (error) {
      setLookupError(friendlyError(error, "Couldn't look that model up."));
      setLookup("error");
    }
  }

  const modelSubject: ApplySubject | null = found
    ? { title: found.name, model: found, notes: found.free ? [] : [costNote(found)] }
    : null;
  const presetSubject: ApplySubject = {
    title: `your OpenRouter preset ${slug}`,
    presetSlug: slug,
    info: "Beta. A preset can include paid models; those use your OpenRouter credit. Your agent says hello through the preset before it shows a tick.",
    notes: []
  };

  return (
    <section className="os-panel os-mp-web" aria-labelledby="os-mp-web-title">
      <header className="os-mp-web__head">
        <div>
          <h3 id="os-mp-web-title">Choose on OpenRouter&apos;s website</h3>
          <p className="os-mp-hint">Pick on OpenRouter, then bring the result back here. Nothing changes until you press the button under it.</p>
        </div>
        <button type="button" className="os-btn os-btn--ghost os-mp__close" onClick={onClose} disabled={busy} aria-label="Close">
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      {openNote ? (
        <p className="os-mp-hint os-mp-hint--warn" role="status">
          <StatusMark kind="warn" label="note" />
          <span>
            {openNote.text}{" "}
            {openNote.url ? (
              <a href={openNote.url} target="_blank" rel="noopener noreferrer">
                {openNote.url}
              </a>
            ) : null}
          </span>
        </p>
      ) : null}

      <div className="os-mp-web__paths">
        <div className="os-mp-web__path">
          <h4>Browse models, then paste the ID</h4>
          <div className="os-mp-row-actions">
            <button type="button" className="os-btn os-btn--secondary" onClick={() => void open(() => openOpenRouterModels())} disabled={busy}>
              Browse models on OpenRouter <ExternalLink size={13} aria-hidden="true" />
            </button>
          </div>
          <label className="os-field">
            <span className="os-field__label">Model ID</span>
            <span className="os-mp-inline">
              <input
                type="text"
                value={pasted}
                maxLength={200}
                placeholder="author/model-name"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => {
                  setPasted(event.target.value);
                  if (lookup === "error") setLookup("idle");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void lookUp();
                  }
                }}
              />
              <button type="button" className="os-btn os-btn--secondary" onClick={() => void lookUp()} disabled={!pasted.trim() || lookup === "looking" || busy}>
                {lookup === "looking" ? "Looking…" : "Look up"}
              </button>
            </span>
          </label>
          <p className="os-mp-hint">On a model&apos;s page, copy its ID (e.g. anthropic/claude-sonnet-4.6).</p>
          {lookup === "error" ? (
            <p className="os-mp-error" role="alert">
              <StatusMark kind="error" /> {lookupError}
            </p>
          ) : null}
          {found && modelSubject ? (
            <div className="os-mp-found">
              <p className="os-mp-found__name">
                <strong>{found.name}</strong> <span className="os-mono">{found.id}</span>
              </p>
              <p className="os-mp-hint">
                <span className={`os-mp-price${found.free ? " os-mp-price--free" : ""}`}>{found.pricing.label}</span> ·{" "}
                {found.contextLength ? `${formatTokens(found.contextLength)} context` : "context not listed"}
              </p>
              <ModelApplyPanel
                key={found.id}
                subject={modelSubject}
                targets={targets}
                initialTargets={initialAgents}
                apply={apply}
                flowId={flowId}
                onFlowChange={setFlowId}
                onBusyChange={setBusy}
                onApplied={onChanged}
                onPickAnother={() => {
                  setFound(null);
                  setPasted("");
                }}
                pickAnotherLabel="Look up another model"
              />
            </div>
          ) : null}
        </div>

        <div className="os-mp-web__path">
          <h4>
            Presets <span className="os-chip os-chip--experimental">beta</span>
          </h4>
          <p className="os-mp-hint">A preset is a model setup you save on OpenRouter. You pick models on OpenRouter; your agents follow automatically.</p>
          <div className="os-mp-row-actions">
            <button type="button" className="os-btn os-btn--secondary" onClick={() => void open(() => openOpenRouterPresets())} disabled={busy}>
              Open OpenRouter presets <ExternalLink size={13} aria-hidden="true" />
            </button>
            <button type="button" className="os-mp-link" onClick={() => void open(() => openOpenRouterPresets(true))} disabled={busy}>
              Make a new preset
            </button>
          </div>
          <label className="os-field">
            <span className="os-field__label">Preset name</span>
            <input
              type="text"
              value={slugText}
              maxLength={80}
              placeholder="my-agent-brain"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setSlugText(event.target.value)}
            />
          </label>
          <p className="os-mp-hint">The name on the preset&apos;s page: lowercase letters, numbers and dashes.</p>
          <ModelApplyPanel
            key={slug}
            subject={presetSubject}
            targets={targets}
            initialTargets={initialAgents}
            apply={apply}
            flowId={flowId}
            onFlowChange={setFlowId}
            onBusyChange={setBusy}
            onApplied={onChanged}
            applyLabel={() => "Use this preset"}
            disabledReason={!slug ? "Type the preset's name first." : !slugOk ? "A preset name uses only lowercase letters, numbers and dashes." : ""}
            pickAnotherLabel="Use a different preset"
            onPickAnother={() => setSlugText("")}
          />
        </div>
      </div>
    </section>
  );
}
