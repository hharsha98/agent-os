import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Cloud,
  Code2,
  Copy,
  Cpu,
  Database,
  ExternalLink,
  KeyRound,
  Library,
  Loader2,
  Network,
  RefreshCcw,
  Save,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  TestTube2,
  TriangleAlert
} from "lucide-react";
import { useMemo, useState } from "react";

export interface CodexApiStatus {
  configured: boolean;
  presentationMode?: boolean;
  status: string;
  model: string;
  baseUrl: string;
  reasoningEffort: string;
  timeoutMs: number;
  keySource: string;
  publicSummary: string;
}

export interface ApiIntegration {
  id: string;
  name: string;
  category: string;
  kind: "gateway" | "hosted" | "local" | "resource";
  badge: string;
  summary: string;
  bestFor: string;
  repoUrl: string;
  docsUrl: string;
  license: string;
  install: string;
  start: string;
  defaultBaseUrl: string;
  defaultModel: string;
  apiKeyRequired: boolean;
  auth: string;
  steps: string[];
  caveats: string[];
  connectable: boolean;
  configured: boolean;
  configuredFields: string[];
  savedBaseUrl: string;
  savedModel: string;
  hasApiKey: boolean;
}

interface Props {
  codex: CodexApiStatus;
  integrations: ApiIntegration[];
  onChanged: () => Promise<void> | void;
}

interface ShowcaseProvider {
  name: string;
  access: string;
  logo: string;
  initials: string;
}

interface ShowcaseGroup {
  id: string;
  title: string;
  count: string;
  tone: "orange" | "green" | "blue";
  providers: ShowcaseProvider[];
}

const iconify = (icon: string) => `https://api.iconify.design/${icon}.svg`;

const SHOWCASE_GROUPS: ShowcaseGroup[] = [
  {
    id: "compatible",
    title: "API-compatible routes",
    count: "3 route formats",
    tone: "orange",
    providers: [
      { name: "Anthropic compatible", access: "Messages", logo: iconify("logos:anthropic-icon"), initials: "AN" },
      { name: "OpenAI compatible", access: "Chat", logo: iconify("logos:openai-icon"), initials: "OA" },
      { name: "OpenAI Responses", access: "Responses", logo: iconify("logos:openai-icon"), initials: "OA" }
    ]
  },
  {
    id: "ai-providers",
    title: "Free, free-tier & local AI",
    count: "15 featured of 27",
    tone: "green",
    providers: [
      { name: "Google Gemini", access: "Free tier", logo: iconify("logos:google-gemini"), initials: "GE" },
      { name: "Groq", access: "Free tier", logo: iconify("bxl:groq-ai"), initials: "GQ" },
      { name: "DeepSeek", access: "API access", logo: iconify("logos:deepseek-icon"), initials: "DS" },
      { name: "Mistral AI", access: "Free tier", logo: iconify("logos:mistral-ai-icon"), initials: "MI" },
      { name: "OpenRouter", access: "Free models", logo: iconify("simple-icons:openrouter"), initials: "OR" },
      { name: "Cerebras", access: "Free tier", logo: "https://cdn.sanity.io/images/e4qjo92p/production/e7a55ae5ab7e2c4fdfd4e66a51f628d1f2f44207-967x967.png?w=128&h=128&fit=max&auto=format", initials: "CE" },
      { name: "NVIDIA NIM", access: "Developer API", logo: iconify("logos:nvidia"), initials: "NV" },
      { name: "Cloudflare Workers AI", access: "Free allocation", logo: iconify("logos:cloudflare-workers-icon"), initials: "CF" },
      { name: "Hugging Face", access: "Free tier", logo: iconify("logos:hugging-face"), initials: "HF" },
      { name: "Pollinations AI", access: "No key", logo: "https://pollinations.ai/favicon.ico", initials: "PA" },
      { name: "Puter", access: "User-pays", logo: "https://puter.com/favicon.ico", initials: "PU" },
      { name: "Ollama", access: "Local & free", logo: iconify("simple-icons:ollama"), initials: "OL" },
      { name: "LocalAI", access: "Local & free", logo: "https://localai.io/favicon.svg", initials: "LA" },
      { name: "Together AI", access: "Developer API", logo: "https://cdn.prod.website-files.com/69654e88dce9154b5f1206dd/699e382b218f39bfa0a115d9_favicon.png", initials: "TO" },
      { name: "Stability AI", access: "Media API", logo: iconify("logos:stability-ai-icon"), initials: "ST" }
    ]
  },
  {
    id: "developer-apis",
    title: "OAuth & developer APIs",
    count: "10 featured of 16",
    tone: "blue",
    providers: [
      { name: "GitHub", access: "OAuth", logo: iconify("logos:github-icon"), initials: "GH" },
      { name: "Slack", access: "OAuth", logo: iconify("logos:slack-icon"), initials: "SL" },
      { name: "Notion", access: "Free plan", logo: iconify("logos:notion-icon"), initials: "NO" },
      { name: "Stripe", access: "Developer API", logo: iconify("logos:stripe"), initials: "SR" },
      { name: "Twilio", access: "Trial", logo: iconify("logos:twilio-icon"), initials: "TW" },
      { name: "Spotify", access: "OAuth", logo: iconify("logos:spotify-icon"), initials: "SP" },
      { name: "Google Maps", access: "Developer API", logo: iconify("logos:google-maps"), initials: "GM" },
      { name: "Discord", access: "OAuth", logo: iconify("logos:discord-icon"), initials: "DI" },
      { name: "Airtable", access: "Free plan", logo: iconify("logos:airtable"), initials: "AT" },
      { name: "Zapier", access: "Free plan", logo: iconify("logos:zapier"), initials: "ZA" }
    ]
  }
];

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
  return body as T;
}

function kindIcon(kind: ApiIntegration["kind"]) {
  if (kind === "gateway") return Network;
  if (kind === "local") return Cpu;
  if (kind === "hosted") return Cloud;
  return Library;
}

function prettyKind(kind: ApiIntegration["kind"]) {
  if (kind === "gateway") return "Gateways";
  if (kind === "local") return "Local runtimes";
  if (kind === "hosted") return "Hosted APIs";
  return "Resources";
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }
  return <button className="aos-copy-button" onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied" : label}</button>;
}

function ShowcaseLogo({ provider }: { provider: ShowcaseProvider }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="aos-provider-logo" aria-hidden="true">
      <strong>{provider.initials}</strong>
      {!failed ? <img src={provider.logo} alt="" onError={() => setFailed(true)} /> : null}
    </span>
  );
}

function ProviderShowcase() {
  return (
    <section className="aos-provider-showcase" aria-labelledby="api-ecosystem-title">
      <div className="aos-provider-showcase-shell">
        <header className="aos-provider-showcase-hero">
          <div className="aos-provider-showcase-copy">
            <span><Library size={14} /> FREE API ECOSYSTEM</span>
            <h2 id="api-ecosystem-title">Discover 3,000+ public APIs</h2>
            <p>A visual discovery catalogue of free tiers, no-key services, OAuth tools, and local runtimes. The providers below are featured examples; use the verified guides for live setup.</p>
            <div className="aos-provider-showcase-stats" aria-label="API catalogue highlights">
              <span><strong>27</strong> free-tier routes indexed</span>
              <span><strong>16</strong> OAuth & developer routes</span>
              <span><strong>10</strong> verified guides below</span>
            </div>
          </div>
          <div className="aos-provider-showcase-count">
            <strong>3,000+</strong>
            <span>PUBLIC · FREE-TIER · LOCAL</span>
            <small>AI, automation, data, media, and developer APIs</small>
          </div>
        </header>

        <div className="aos-provider-groups">
          {SHOWCASE_GROUPS.map((group) => (
            <section className="aos-provider-group" key={group.id} aria-labelledby={`${group.id}-title`}>
              <div className="aos-provider-group-head">
                <div><span className={`aos-provider-group-dot tone-${group.tone}`} /><h3 id={`${group.id}-title`}>{group.title}</h3></div>
                <span>{group.count}</span>
              </div>
              <ul className="aos-provider-grid">
                {group.providers.map((provider) => (
                  <li className="aos-provider-tile" key={provider.name}>
                    <ShowcaseLogo provider={provider} />
                    <span className="aos-provider-tile-copy"><strong title={provider.name}>{provider.name}</strong><small>{provider.access}</small></span>
                    <span className={`aos-provider-status tone-${group.tone}`} aria-hidden="true" />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <footer className="aos-provider-showcase-foot">
          <span><ShieldCheck size={14} /> Availability, keys, and quotas are controlled by each provider.</span>
          <a href="#verified-api-library">Explore verified integrations <ChevronDown size={14} /></a>
        </footer>
      </div>
    </section>
  );
}

function CodexPowerCard({ codex, onChanged }: { codex: CodexApiStatus; onChanged: Props["onChanged"] }) {
  const [fields, setFields] = useState<Record<string, string>>({
    AGENT_OS_CODEX_MODEL: codex.model || "gpt-5.3-codex",
    AGENT_OS_CODEX_REASONING_EFFORT: codex.reasoningEffort || "medium",
    AGENT_OS_OPENAI_BASE_URL: codex.baseUrl || "https://api.openai.com/v1",
    AGENT_OS_CODEX_TIMEOUT_MS: String(codex.timeoutMs || 90000)
  });
  const [busy, setBusy] = useState<"save" | "test" | "">("");
  const [result, setResult] = useState("");

  async function save() {
    setBusy("save");
    setResult("");
    try {
      await request("/api/connections/provider-openai/configure", {
        method: "POST",
        body: JSON.stringify({ fields })
      });
      setFields((current) => ({ ...current, OPENAI_API_KEY: "" }));
      setResult("Codex API settings saved on the local Agent OS server.");
      await onChanged();
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Could not save Codex API settings.");
    } finally {
      setBusy("");
    }
  }

  async function test() {
    setBusy("test");
    setResult("");
    try {
      await request("/api/connections/provider-openai/configure", {
        method: "POST",
        body: JSON.stringify({ fields })
      });
      setFields((current) => ({ ...current, OPENAI_API_KEY: "" }));
      const response = await request<{ message: string; latencyMs: number }>("/api/agent-os/codex/test", { method: "POST", body: "{}" });
      setResult(`${response.message} ${response.latencyMs} ms.`);
      await onChanged();
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Codex API test failed.");
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="aos-codex-power">
      <div className="aos-codex-power-main">
        <div className="aos-power-mark"><Sparkles size={27} /></div>
        <div className="aos-power-copy">
          <span>PRIMARY INTELLIGENCE</span>
          <h2>Agent OS is powered by Codex API</h2>
          <p>Codex generates and edits visual workflows, reasons inside preview nodes, and powers test responses. OpenClaw and Hermes remain the execution runtimes.</p>
          <div className="aos-power-meta">
            <span className={codex.configured ? "ready" : "missing"}>{codex.configured ? <CheckCircle2 size={14} /> : <CircleDot size={14} />}{codex.configured ? "Configured" : "API key required"}</span>
            <span><Code2 size={14} /> {codex.model || "gpt-5.3-codex"}</span>
            <span><ShieldCheck size={14} /> Server-side key</span>
          </div>
        </div>
      </div>
      <div className="aos-codex-config">
        <label className="aos-field">
          <span>OpenAI API key {codex.configured ? <i><Check size={12} /> Saved</i> : null}</span>
          <input type="password" value={fields.OPENAI_API_KEY || ""} onChange={(event) => setFields((current) => ({ ...current, OPENAI_API_KEY: event.target.value }))} placeholder={codex.configured ? "Enter only to replace the saved key" : "sk-…"} />
        </label>
        <div className="aos-api-form-row">
          <label className="aos-field"><span>Codex model</span><input value={fields.AGENT_OS_CODEX_MODEL || ""} onChange={(event) => setFields((current) => ({ ...current, AGENT_OS_CODEX_MODEL: event.target.value }))} /></label>
          <label className="aos-field"><span>Reasoning</span><select value={fields.AGENT_OS_CODEX_REASONING_EFFORT || "medium"} onChange={(event) => setFields((current) => ({ ...current, AGENT_OS_CODEX_REASONING_EFFORT: event.target.value }))}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option></select></label>
        </div>
        <label className="aos-field"><span>Responses API base URL</span><input value={fields.AGENT_OS_OPENAI_BASE_URL || ""} onChange={(event) => setFields((current) => ({ ...current, AGENT_OS_OPENAI_BASE_URL: event.target.value }))} /></label>
        <div className="aos-inline-actions">
          <button className="aos-secondary" disabled={Boolean(busy)} onClick={save}>{busy === "save" ? <Loader2 className="aos-spin" size={16} /> : <Save size={16} />} Save</button>
          <button className="aos-primary" disabled={Boolean(busy)} onClick={test}>{busy === "test" ? <Loader2 className="aos-spin" size={16} /> : <TestTube2 size={16} />} Save & test</button>
          <a className="aos-doc-link" href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">Get an API key <ArrowUpRight size={14} /></a>
        </div>
        {result ? <div className="aos-api-result">{result}</div> : null}
      </div>
    </section>
  );
}

function IntegrationGuide({ item, onChanged }: { item: ApiIntegration; onChanged: Props["onChanged"] }) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({
    BASE_URL: item.savedBaseUrl || item.defaultBaseUrl,
    MODEL: item.savedModel || item.defaultModel,
    API_KEY: ""
  });
  const [busy, setBusy] = useState<"save" | "test" | "">("");
  const [result, setResult] = useState("");
  const Icon = kindIcon(item.kind);

  async function save() {
    setBusy("save");
    setResult("");
    try {
      const response = await request<{ message: string }>(`/api/agent-os/api-integrations/${item.id}/configure`, {
        method: "POST",
        body: JSON.stringify({ fields })
      });
      setFields((current) => ({ ...current, API_KEY: "" }));
      setResult(response.message);
      await onChanged();
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Could not save this integration.");
    } finally {
      setBusy("");
    }
  }

  async function test() {
    setBusy("test");
    setResult("");
    try {
      const response = await request<{ message: string; latencyMs: number; models?: string[] }>(`/api/agent-os/api-integrations/${item.id}/test`, {
        method: "POST",
        body: JSON.stringify({ fields })
      });
      setResult(`${response.message} ${response.latencyMs} ms${response.models?.length ? ` — ${response.models.slice(0, 5).join(", ")}` : ""}`);
      await onChanged();
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Connection test failed.");
    } finally {
      setBusy("");
    }
  }

  return (
    <article className={`aos-api-card ${open ? "open" : ""}`}>
      <button className="aos-api-card-summary" onClick={() => setOpen((value) => !value)}>
        <span className={`aos-api-kind kind-${item.kind}`}><Icon size={20} /></span>
        <span className="aos-api-card-copy"><span>{item.category}</span><strong>{item.name}</strong><small>{item.summary}</small></span>
        <span className="aos-api-card-side"><em>{item.badge}</em>{item.configured ? <i><CheckCircle2 size={13} /> Connected</i> : null}{open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</span>
      </button>
      {open ? (
        <div className="aos-api-guide">
          <div className="aos-api-guide-main">
            <div className="aos-api-fact"><span>BEST FOR</span><p>{item.bestFor}</p></div>
            <div className="aos-api-command"><span>INSTALL</span><code>{item.install}</code>{item.kind !== "resource" ? <CopyButton value={item.install} /> : null}</div>
            <div className="aos-api-command"><span>START / USE</span><code>{item.start}</code>{item.kind !== "resource" ? <CopyButton value={item.start} /> : null}</div>
            <div className="aos-api-steps"><span>CONNECT TO AGENT OS</span><ol>{item.steps.map((step) => <li key={step}>{step}</li>)}</ol></div>
            <div className="aos-api-warning"><TriangleAlert size={17} /><div>{item.caveats.map((caveat) => <p key={caveat}>{caveat}</p>)}</div></div>
            <div className="aos-api-source-row"><span>License: {item.license}</span><a href={item.repoUrl} target="_blank" rel="noreferrer">GitHub source <ExternalLink size={13} /></a><a href={item.docsUrl} target="_blank" rel="noreferrer">Upstream guide <ExternalLink size={13} /></a></div>
          </div>
          <aside className="aos-api-connect">
            {item.connectable ? <>
              <div className="aos-panel-head"><div><span>AGENT OS CONNECTION</span><h2>Configure & test</h2></div><Server size={20} /></div>
              <label className="aos-field"><span>Base URL</span><input value={fields.BASE_URL || ""} onChange={(event) => setFields((current) => ({ ...current, BASE_URL: event.target.value }))} /></label>
              <label className="aos-field"><span>API / gateway key {item.hasApiKey ? <i><Check size={12} /> Saved</i> : null}</span><input type="password" value={fields.API_KEY || ""} onChange={(event) => setFields((current) => ({ ...current, API_KEY: event.target.value }))} placeholder={item.hasApiKey ? "Enter only to replace" : item.apiKeyRequired ? "Required" : "Optional"} /></label>
              <label className="aos-field"><span>Model {item.defaultModel ? `(default: ${item.defaultModel})` : ""}</span><input value={fields.MODEL || ""} onChange={(event) => setFields((current) => ({ ...current, MODEL: event.target.value }))} placeholder="Choose an ID returned by /models" /></label>
              <p className="aos-api-auth"><KeyRound size={14} /> {item.auth}</p>
              <div className="aos-inline-actions"><button className="aos-secondary" disabled={Boolean(busy)} onClick={save}>{busy === "save" ? <Loader2 className="aos-spin" size={15} /> : <Save size={15} />} Save</button><button className="aos-primary" disabled={Boolean(busy)} onClick={test}>{busy === "test" ? <Loader2 className="aos-spin" size={15} /> : <TestTube2 size={15} />} Test</button></div>
              {result ? <div className="aos-api-result">{result}</div> : null}
            </> : <div className="aos-resource-box"><Library size={30} /><strong>Reference library</strong><p>This repository cannot be connected directly. Use it to select a provider, then connect that provider or one of the gateways above.</p><a href={item.repoUrl} target="_blank" rel="noreferrer">Open directory <ArrowUpRight size={14} /></a></div>}
          </aside>
        </div>
      ) : null}
    </article>
  );
}

export default function ApiGuidePage({ codex, integrations, onChanged }: Props) {
  const [filter, setFilter] = useState<"all" | ApiIntegration["kind"]>("all");
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => integrations.filter((item) => {
    const matchesKind = filter === "all" || item.kind === filter;
    const haystack = `${item.name} ${item.category} ${item.summary} ${item.bestFor}`.toLowerCase();
    return matchesKind && haystack.includes(query.trim().toLowerCase());
  }), [integrations, filter, query]);

  return (
    <main className="aos-page aos-api-page">
      <section className="aos-page-intro">
        <span><Database size={15} /> AI POWER & INTEGRATIONS</span>
        <h1>One brain now.<br /><em>Every route ready.</em></h1>
        <p>Codex API powers Agent OS by default. These verified guides show how gateways, hosted APIs, and local model servers can connect without confusing one category for another.</p>
      </section>
      <CodexPowerCard codex={codex} onChanged={onChanged} />
      <ProviderShowcase />
      <section className="aos-api-library" id="verified-api-library">
        <div className="aos-section-head"><div><span>UPSTREAM PROJECTS</span><h2>Free and local AI integration library</h2></div><button className="aos-text-button" onClick={() => void onChanged()}><RefreshCcw size={15} /> Refresh</button></div>
        <div className="aos-api-toolbar">
          <div className="aos-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search ten verified projects…" /></div>
          <div className="aos-api-filters">{(["all", "gateway", "local", "hosted", "resource"] as const).map((kind) => <button key={kind} className={filter === kind ? "active" : ""} onClick={() => setFilter(kind)}>{kind === "all" ? `All ${integrations.length}` : prettyKind(kind)}</button>)}</div>
        </div>
        <div className="aos-api-list">{filtered.map((item) => <IntegrationGuide key={item.id} item={item} onChanged={onChanged} />)}</div>
      </section>
    </main>
  );
}
