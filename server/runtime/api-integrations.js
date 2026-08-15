import { configureConnection, getStoredConnectionConfig } from "./connections.js";
import { redactText, sanitizeObject } from "./safety.js";

export const API_INTEGRATIONS = [
  {
    id: "omniroute",
    name: "OmniRoute",
    category: "Smart gateway",
    kind: "gateway",
    badge: "OpenAI compatible",
    summary: "A local multi-provider gateway with routing, retries, fallback, compression, and an OpenAI-compatible endpoint.",
    bestFor: "People who want one local endpoint in front of several free or paid providers.",
    repoUrl: "https://github.com/diegosouzapw/OmniRoute",
    docsUrl: "https://github.com/diegosouzapw/OmniRoute#-quick-start",
    license: "MIT",
    install: "npm install -g omniroute",
    start: "omniroute",
    defaultBaseUrl: "http://127.0.0.1:20128/v1",
    defaultModel: "auto",
    endpointType: "openai",
    apiKeyRequired: true,
    auth: "Copy an endpoint key from OmniRoute Dashboard → Endpoints.",
    steps: [
      "Install and start OmniRoute, then open its dashboard on port 20128.",
      "Connect at least one provider inside OmniRoute.",
      "Copy the endpoint key and keep the base URL ending in /v1.",
      "Save and test below. Agent OS verifies the /models endpoint."
    ],
    caveats: ["Provider availability and free quotas are controlled by each upstream provider.", "Keep OmniRoute bound to localhost unless you deliberately secure remote access."]
  },
  {
    id: "cliproxyapi",
    name: "CLIProxyAPI",
    category: "CLI account proxy",
    kind: "gateway",
    badge: "OpenAI + Responses",
    summary: "Wraps authorized CLI/OAuth accounts behind OpenAI, Gemini, Claude, Codex, and Grok-compatible APIs.",
    bestFor: "Advanced local users who already have authorized CLI accounts and need a compatibility endpoint.",
    repoUrl: "https://github.com/router-for-me/CLIProxyAPI",
    docsUrl: "https://help.router-for.me/",
    license: "MIT",
    install: "git clone https://github.com/router-for-me/CLIProxyAPI.git",
    start: "docker compose up -d",
    defaultBaseUrl: "http://127.0.0.1:8317/v1",
    defaultModel: "",
    endpointType: "openai",
    apiKeyRequired: true,
    auth: "Set an api-keys entry in config.yaml and enter the same key here.",
    steps: [
      "Clone the repository and copy config.example.yaml to config.yaml.",
      "Bind the server to 127.0.0.1, keep port 8317, and create a strong api-keys value.",
      "Complete only the OAuth/login flows for accounts you are authorized to use.",
      "Start the service, enter its /v1 URL and API key below, then test available models."
    ],
    caveats: ["Use only accounts and subscriptions whose terms permit this access pattern.", "Do not expose its management API or OAuth files publicly."]
  },
  {
    id: "free-llm-gateway",
    name: "Free LLM Gateway",
    category: "Provider aggregator",
    kind: "gateway",
    badge: "OpenAI compatible",
    summary: "A Python gateway that aggregates multiple providers with fallback routing, quotas, analytics, and gateway keys.",
    bestFor: "A self-hosted fallback layer across several user-owned free-tier API keys.",
    repoUrl: "https://github.com/MrFadiAi/free-llm-gateway",
    docsUrl: "https://github.com/MrFadiAi/free-llm-gateway#quick-start",
    license: "MIT",
    install: "git clone https://github.com/MrFadiAi/free-llm-gateway.git && cd free-llm-gateway && pip install -r requirements.txt",
    start: "python main.py",
    defaultBaseUrl: "http://127.0.0.1:8080/v1",
    defaultModel: "",
    endpointType: "openai",
    apiKeyRequired: true,
    auth: "Create a gateway/master key in the gateway and enter it here.",
    steps: [
      "Clone the project, install requirements, and copy .env.example to .env.",
      "Add at least one provider key that you own.",
      "Start the dashboard on port 8080 and create a gateway key.",
      "Save the /v1 endpoint below, test it, then choose one returned model ID."
    ],
    caveats: ["The gateway is free software; upstream model usage may still have limits or costs.", "Review fallback order before sending sensitive workloads to multiple providers."]
  },
  {
    id: "gpt4free",
    name: "GPT4Free",
    category: "Compatibility layer",
    kind: "gateway",
    badge: "Experimental",
    summary: "A Python provider collection with a local GUI and an OpenAI-style Interference API.",
    bestFor: "Personal experiments where provider instability and browser-assisted authentication are acceptable.",
    repoUrl: "https://github.com/xtekky/gpt4free",
    docsUrl: "https://github.com/xtekky/gpt4free#interference-api-openaicompatible",
    license: "GPL-3.0",
    install: "docker pull hlohaus789/g4f:latest-slim",
    start: "docker run --rm -p 1337:8080 hlohaus789/g4f:latest-slim",
    defaultBaseUrl: "http://127.0.0.1:1337/v1",
    defaultModel: "",
    endpointType: "openai",
    apiKeyRequired: false,
    auth: "Usually no local gateway key; individual providers may require cookies, tokens, or accounts.",
    steps: [
      "Run the recommended Docker image or install the Python package.",
      "Start its FastAPI/Interference API and confirm Swagger is available.",
      "Configure only providers you are legally authorized to access.",
      "Enter the local /v1 endpoint below and test the model list."
    ],
    caveats: ["Provider adapters can break without notice and may rely on browser automation.", "Review each provider's terms and privacy behavior before use; Agent OS will never select this by default."]
  },
  {
    id: "new-api",
    name: "New API",
    category: "Model hub",
    kind: "gateway",
    badge: "Multi-format gateway",
    summary: "A self-hosted model hub for channels, tokens, quotas, and OpenAI/Claude/Gemini-compatible interfaces.",
    bestFor: "Teams that need a managed internal gateway with users, tokens, quotas, and multiple upstream channels.",
    repoUrl: "https://github.com/QuantumNous/new-api",
    docsUrl: "https://docs.newapi.pro/",
    license: "AGPL-3.0",
    install: "docker pull calciumion/new-api:latest",
    start: "docker run --name new-api -d --restart unless-stopped -p 3000:3000 -v ./data:/data calciumion/new-api:latest",
    defaultBaseUrl: "http://127.0.0.1:3000/v1",
    defaultModel: "",
    endpointType: "openai",
    apiKeyRequired: true,
    auth: "Create a New API user token after configuring an authorized upstream channel.",
    steps: [
      "Deploy New API with persistent /data storage and open its dashboard on port 3000.",
      "Create an administrator, add an authorized model channel, and map model names.",
      "Issue a user token with an appropriate quota.",
      "Enter the /v1 URL and token below, then test and choose a returned model."
    ],
    caveats: ["OpenAI Responses conversion is still described upstream as in development; prefer Chat Completions compatibility unless verified.", "Public deployments require proper secrets, TLS, database backups, and jurisdiction-specific compliance."]
  },
  {
    id: "pollinations",
    name: "Pollinations",
    category: "Hosted multimodal API",
    kind: "hosted",
    badge: "Text + image + audio + video",
    summary: "A hosted open-source generative platform with text, image, audio, video, and an MCP package.",
    bestFor: "Adding media-generation tools to Hermes or OpenClaw workflows.",
    repoUrl: "https://github.com/pollinations/pollinations",
    docsUrl: "https://github.com/pollinations/pollinations#-getting-started",
    license: "Project-specific open-source licenses",
    install: "npx @pollinations/mcp",
    start: "Use hosted API or run the Pollinations MCP server",
    defaultBaseUrl: "https://gen.pollinations.ai",
    defaultModel: "openai",
    endpointType: "pollinations",
    apiKeyRequired: true,
    auth: "Create a server-side sk_ key at enter.pollinations.ai; never paste it into client-side code.",
    steps: [
      "Create a scoped Pollinations API key and restrict its models/budget.",
      "Save the hosted base URL and key below.",
      "Test text generation, then add Pollinations as an Agent OS media tool.",
      "For native agent tool use, run @pollinations/mcp and connect that MCP server to Hermes/OpenClaw."
    ],
    caveats: ["Secret sk_ keys must remain server-side; use scoped public keys only for browser applications.", "Media endpoints have different request and output formats, so this is a tool integration rather than the default Codex brain."]
  },
  {
    id: "ollama",
    name: "Ollama",
    category: "Local model runtime",
    kind: "local",
    badge: "Private local models",
    summary: "A local runtime for downloading and serving open models with native and OpenAI-compatible APIs.",
    bestFor: "The easiest private local option for lightweight agent reasoning and provider routing.",
    repoUrl: "https://github.com/ollama/ollama",
    docsUrl: "https://docs.ollama.com/api/openai-compatibility",
    license: "MIT",
    install: "curl -fsSL https://ollama.com/install.sh | sh",
    start: "ollama serve",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "",
    endpointType: "ollama",
    apiKeyRequired: false,
    auth: "No key is required for the default localhost server.",
    steps: [
      "Install Ollama, start it, and pull a model appropriate for your hardware.",
      "Confirm `ollama list` shows the model.",
      "Keep the Agent OS base URL on localhost with /v1.",
      "Test below and enter the exact local model name."
    ],
    caveats: ["Model quality, memory use, and tool support depend on the selected model.", "Do not expose the unauthenticated default server to an untrusted network."]
  },
  {
    id: "localai",
    name: "LocalAI",
    category: "Local AI engine",
    kind: "local",
    badge: "OpenAI compatible",
    summary: "A broad local AI engine supporting language, vision, audio, images, embeddings, tools, and many inference backends.",
    bestFor: "A self-hosted OpenAI-compatible stack that needs more modalities and backend choices than a simple LLM server.",
    repoUrl: "https://github.com/mudler/LocalAI",
    docsUrl: "https://localai.io/docs/",
    license: "MIT",
    install: "docker pull localai/localai:latest",
    start: "docker run --rm -p 8080:8080 localai/localai:latest",
    defaultBaseUrl: "http://127.0.0.1:8080/v1",
    defaultModel: "",
    endpointType: "openai",
    apiKeyRequired: false,
    auth: "No key by default on localhost; configure LocalAI auth before any remote exposure.",
    steps: [
      "Start the CPU or GPU container matching your machine.",
      "Install/configure at least one model in LocalAI.",
      "Enter the localhost /v1 endpoint below.",
      "Test the model catalogue and save the exact model ID."
    ],
    caveats: ["Initial model download and startup can be slow.", "The macOS app is described upstream as unsigned; review installation steps before changing Gatekeeper settings."]
  },
  {
    id: "llama-cpp",
    name: "llama.cpp",
    category: "Local inference server",
    kind: "local",
    badge: "GGUF + OpenAI compatible",
    summary: "A lightweight C/C++ inference engine whose llama-server exposes an OpenAI-compatible HTTP API.",
    bestFor: "Maximum control, low overhead, and direct GGUF model serving on local hardware.",
    repoUrl: "https://github.com/ggml-org/llama.cpp",
    docsUrl: "https://github.com/ggml-org/llama.cpp/tree/master/tools/server",
    license: "MIT",
    install: "brew install llama.cpp",
    start: "llama-server -hf ggml-org/gemma-3-1b-it-GGUF --port 8080",
    defaultBaseUrl: "http://127.0.0.1:8080/v1",
    defaultModel: "",
    endpointType: "openai",
    apiKeyRequired: false,
    auth: "No key by default; use llama-server authentication options before remote exposure.",
    steps: [
      "Install llama.cpp and choose a compatible GGUF model.",
      "Start llama-server on localhost and wait until the model is loaded.",
      "Enter the server's /v1 endpoint below.",
      "Test the model list, then use the returned model identifier in Agent OS."
    ],
    caveats: ["Context size and parallelism must fit available RAM/VRAM.", "Agent tools are orchestrated by Agent OS; llama-server itself is primarily an inference endpoint."]
  },
  {
    id: "awesome-free-llm-apis",
    name: "Awesome Free LLM APIs",
    category: "Provider directory",
    kind: "resource",
    badge: "Research list",
    summary: "A curated comparison of free-tier LLM APIs, rate limits, models, SDKs, and OpenAI compatibility.",
    bestFor: "Finding a provider, then connecting that provider through a custom compatible endpoint.",
    repoUrl: "https://github.com/amardeeplakshkar/awesome-free-llm-apis",
    docsUrl: "https://github.com/amardeeplakshkar/awesome-free-llm-apis#code-snippets--how-to-use-free-llm-apis-with-the-openai-sdk",
    license: "CC0-1.0",
    install: "No installation — this is a directory, not an API server.",
    start: "Choose a listed provider and obtain its official API key.",
    defaultBaseUrl: "",
    defaultModel: "",
    endpointType: "resource",
    apiKeyRequired: false,
    auth: "Depends on the provider selected from the directory.",
    steps: [
      "Open the directory and compare current limits, models, and OpenAI SDK compatibility.",
      "Verify the chosen provider in its official documentation before signing up.",
      "Copy that provider's official base URL, API key, and model ID.",
      "Connect it through an appropriate Agent OS gateway or custom provider profile."
    ],
    caveats: ["This repository is not directly connectable and cannot be health-tested as an API.", "Free tiers and rate limits can change; verify them with the provider before relying on them."]
  }
];

function profileId(id) {
  return `ai-source-${id}`;
}

function integrationById(id) {
  return API_INTEGRATIONS.find((item) => item.id === id) || null;
}

function cleanBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const error = new Error("Enter a valid http or https base URL.");
    error.status = 400;
    throw error;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    const error = new Error("The base URL must use http or https and cannot contain credentials.");
    error.status = 400;
    throw error;
  }
  return raw;
}

function publicIntegration(item, stored) {
  const profile = stored[profileId(item.id)] || {};
  const configuredFields = Object.keys(profile).filter((key) => String(profile[key] || "").trim());
  return {
    ...item,
    connectable: item.endpointType !== "resource",
    configured: configuredFields.includes("BASE_URL") && (!item.apiKeyRequired || configuredFields.includes("API_KEY")),
    configuredFields,
    savedBaseUrl: profile.BASE_URL || "",
    savedModel: profile.MODEL || "",
    hasApiKey: configuredFields.includes("API_KEY")
  };
}

export async function listApiIntegrations() {
  const stored = await getStoredConnectionConfig();
  return {
    ok: true,
    defaultProvider: "codex-api",
    integrations: API_INTEGRATIONS.map((item) => publicIntegration(item, stored))
  };
}

export async function configureApiIntegration(id, fields = {}) {
  const item = integrationById(id);
  if (!item) {
    const error = new Error(`Unknown AI API integration: ${id}`);
    error.status = 404;
    throw error;
  }
  if (item.endpointType === "resource") {
    const error = new Error(`${item.name} is a research directory, not a connectable API.`);
    error.status = 400;
    throw error;
  }
  const baseUrl = cleanBaseUrl(fields.BASE_URL || item.defaultBaseUrl);
  const safeFields = {
    BASE_URL: baseUrl,
    MODEL: String(fields.MODEL || item.defaultModel || "").trim().slice(0, 200)
  };
  if (String(fields.API_KEY || "").trim()) safeFields.API_KEY = String(fields.API_KEY).trim().slice(0, 10000);
  const saved = await configureConnection(profileId(id), safeFields);
  return {
    ok: true,
    id,
    configuredFields: saved.configuredFields,
    baseUrl,
    model: safeFields.MODEL,
    message: `${item.name} connection settings saved locally on the Agent OS server.`
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("json")
      ? await response.json().catch(() => ({}))
      : { text: (await response.text()).slice(0, 1000) };
    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || payload?.text || `HTTP ${response.status}`;
      const error = new Error(redactText(String(message)).slice(0, 600));
      error.status = 502;
      error.details = sanitizeObject({ upstreamStatus: response.status });
      throw error;
    }
    return { payload, latencyMs: Date.now() - started };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(`Connection test timed out after ${timeoutMs} ms.`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function testApiIntegration(id, input = {}) {
  const item = integrationById(id);
  if (!item) {
    const error = new Error(`Unknown AI API integration: ${id}`);
    error.status = 404;
    throw error;
  }
  if (item.endpointType === "resource") {
    const error = new Error(`${item.name} is a directory, not an API endpoint. Open its guide instead.`);
    error.status = 400;
    throw error;
  }
  const stored = await getStoredConnectionConfig();
  const profile = stored[profileId(id)] || {};
  const baseUrl = cleanBaseUrl(input.BASE_URL || profile.BASE_URL || item.defaultBaseUrl);
  const apiKey = String(input.API_KEY || profile.API_KEY || "").trim();
  if (item.apiKeyRequired && !apiKey) {
    const error = new Error(`${item.name} needs an API or gateway key before testing.`);
    error.status = 412;
    throw error;
  }
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  let url;
  if (item.endpointType === "ollama") {
    url = `${baseUrl.replace(/\/v1$/i, "")}/api/tags`;
  } else if (item.endpointType === "pollinations") {
    const query = new URLSearchParams({ key: apiKey, model: input.MODEL || profile.MODEL || item.defaultModel || "openai" });
    url = `${baseUrl}/text/${encodeURIComponent("Reply with exactly: Agent OS connected")}?${query}`;
  } else {
    url = `${baseUrl}/models`;
  }
  const result = await fetchWithTimeout(url, { method: "GET", headers }, 20000);
  const models = Array.isArray(result.payload?.data)
    ? result.payload.data.map((model) => model?.id || model?.name).filter(Boolean)
    : Array.isArray(result.payload?.models)
      ? result.payload.models.map((model) => model?.name || model?.model || model?.id).filter(Boolean)
      : [];
  return {
    ok: true,
    id,
    status: "connected",
    latencyMs: result.latencyMs,
    modelCount: models.length,
    models: models.slice(0, 20),
    message: `${item.name} responded successfully${models.length ? ` with ${models.length} model${models.length === 1 ? "" : "s"}` : ""}.`
  };
}
