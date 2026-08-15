import { promises as fs } from "node:fs";
import { File } from "node:buffer";
import path from "node:path";
import { getConfiguredValue, getStoredConnectionConfig } from "./connections.js";
import { appendModuleLog } from "./module-logs.js";
import { runRouter } from "./router.js";
import { commandVersion, redactText, runCommand, runStreamingCommand, which } from "./safety.js";
import { ensureRuntimeStore, expandHome, fileExists, osRoot, readJson, runtimePaths, withRuntimeHome, writeJson } from "./store.js";
import { isExecutionEnabled } from "./execution-gate.js";

const MODULES = {
  goals: {
    id: "goals",
    label: "Goals",
    itemName: "goal",
    emptySummary: "No goals created yet.",
    defaultStatus: "open"
  },
  notebook: {
    id: "notebook",
    label: "Notebook",
    itemName: "note",
    emptySummary: "No notes created yet."
  },
  seo: {
    id: "seo",
    label: "SEO",
    itemName: "brief",
    emptySummary: "No SEO briefs created yet.",
    defaultStatus: "planned"
  },
  video: {
    id: "video",
    label: "Video",
    itemName: "job",
    emptySummary: "No video jobs created yet.",
    defaultStatus: "queued"
  },
  kanban: {
    id: "kanban",
    label: "Kanban",
    itemName: "card",
    emptySummary: "No cards created yet.",
    defaultColumn: "todo"
  },
  "usage-credits": {
    id: "usage-credits",
    label: "Usage Credits",
    itemName: "entry",
    emptySummary: "No usage entries recorded yet."
  }
};

const PARKED_SELF_MODULE_IDS = new Set(["seo", "video"]);

const MAX_GOAL_HISTORY = 20;
const MAX_SEO_HISTORY = 20;
const MAX_SEO_SEARCH_HISTORY = 20;
const MAX_SEO_COMPETITORS = 20;
const MAX_SEO_RANK_SNAPSHOTS = 20;
const MAX_VIDEO_HISTORY = 20;
const VIDEO_OPERATIONS = new Set(["handoff", "transcribe", "render", "caption_render"]);
const VIDEO_CLOUD_STT_PROVIDERS = ["groq", "openai"];
const VIDEO_RENDER_PRESETS = {
  copy: {
    id: "copy",
    label: "Original copy/remux",
    outputSuffix: "rendered",
    transcode: false,
    filter: "",
    summary: "Preserve original streams, copy/remux to MP4, and add faststart metadata.",
    commandTemplate: "ffmpeg -i {{SOURCE_VIDEO}} -map 0 -c copy -movflags +faststart {{OUTPUT_VIDEO}}"
  },
  web_1080p: {
    id: "web_1080p",
    label: "Web 1080p H.264",
    outputSuffix: "web-1080p",
    transcode: true,
    filter: "scale='min(1920,iw)':-2,format=yuv420p",
    summary: "Transcode to H.264/AAC for broad web playback while preserving aspect ratio.",
    commandTemplate: "ffmpeg -i {{SOURCE_VIDEO}} -vf scale_to_1080p -c:v libx264 -c:a aac -movflags +faststart {{OUTPUT_VIDEO}}"
  },
  vertical_1080x1920: {
    id: "vertical_1080x1920",
    label: "Vertical 1080x1920",
    outputSuffix: "vertical-1080x1920",
    transcode: true,
    filter: "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
    summary: "Fit the source into a 9:16 1080x1920 canvas for Shorts/Reels/TikTok exports.",
    commandTemplate: "ffmpeg -i {{SOURCE_VIDEO}} -vf vertical_1080x1920 -c:v libx264 -c:a aac -movflags +faststart {{OUTPUT_VIDEO}}"
  },
  square_1080: {
    id: "square_1080",
    label: "Square 1080x1080",
    outputSuffix: "square-1080",
    transcode: true,
    filter: "scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
    summary: "Fit the source into a square 1080x1080 social feed canvas.",
    commandTemplate: "ffmpeg -i {{SOURCE_VIDEO}} -vf square_1080 -c:v libx264 -c:a aac -movflags +faststart {{OUTPUT_VIDEO}}"
  }
};
const VIDEO_TERMINAL_STATUSES = new Set(["planned", "completed", "ready_to_configure", "error", "canceled"]);
const SECRET_FIELD_PATTERN = /(^|_)(API_KEY|KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|COOKIE)($|_)/i;
let videoRunQueue = [];
let videoQueueActive = false;
const videoRunControllers = new Map();
const KANBAN_MATCH_KEYS = [
  "sourceType",
  "sourceId",
  "workflowId",
  "runId",
  "nodeId",
  "schedulerJobId",
  "approvalId",
  "linkedModule",
  "linkedItemId"
];

function now() {
  return new Date().toISOString();
}

function cleanDate(value) {
  if (!value) return now();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? now() : date.toISOString();
}

function publicSelfValue(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => publicSelfValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, publicSelfValue(entryValue, entryKey)]));
  }
  if (typeof value === "string") {
    const normalizedKey = String(key || "").replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
    if (SECRET_FIELD_PATTERN.test(normalizedKey) && value) return "configured";
    if (normalizedKey === "SOURCE_PATH") return publicSourceLabel(value);
    return redactText(value);
  }
  return value;
}

function idFor(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function isLocalSelfModule(id) {
  return Boolean(MODULES[id]);
}

export function isParkedSelfModule(id) {
  return PARKED_SELF_MODULE_IDS.has(String(id || ""));
}

export function localSelfModuleIds() {
  return Object.keys(MODULES);
}

async function fileFor(id) {
  if (!isLocalSelfModule(id)) {
    const error = new Error("self module not found");
    error.status = 404;
    throw error;
  }
  const paths = await ensureRuntimeStore();
  return path.join(paths.memory, "self-modules", `${id}.json`);
}

function initialState(id) {
  const definition = MODULES[id];
  return {
    id,
    label: definition.label,
    itemName: definition.itemName,
    items: [],
    summary: {
      total: 0,
      byStatus: {},
      byColumn: {},
      usage: {
        units: 0,
        estimatedCost: 0
      }
    },
    updatedAt: null
  };
}

function summarize(id, items) {
  const summary = {
    total: items.length,
    byStatus: {},
    byColumn: {},
    goals: {
      loopRuns: 0,
      active: 0,
      lastRunAt: null
    },
    seo: {
      auditRuns: 0,
      discoveryRuns: 0,
      rankRuns: 0,
      competitors: 0,
      ready: 0,
      lastRunAt: null
    },
    kanban: {
      pendingApprovals: 0,
      workflowCards: 0,
      schedulerCards: 0,
      completed: 0
    },
    video: {
      workerRuns: 0,
      queued: 0,
      running: 0,
      ready: 0,
      completed: 0,
      canceled: 0,
      lastRunAt: null
    },
    usage: {
      units: 0,
      estimatedCost: 0
    }
  };

  for (const item of items) {
    if (item.status) summary.byStatus[item.status] = (summary.byStatus[item.status] || 0) + 1;
    if (item.column) summary.byColumn[item.column] = (summary.byColumn[item.column] || 0) + 1;
    if (id === "goals") {
      summary.goals.loopRuns += Number(item.loopCount || 0);
      if (!["done", "completed", "archived", "closed"].includes(String(item.status || "").toLowerCase())) {
        summary.goals.active += 1;
      }
      if (item.lastRunAt && (!summary.goals.lastRunAt || item.lastRunAt > summary.goals.lastRunAt)) {
        summary.goals.lastRunAt = item.lastRunAt;
      }
    }
    if (id === "seo") {
      summary.seo.auditRuns += Number(item.auditCount || 0);
      summary.seo.discoveryRuns = Number(summary.seo.discoveryRuns || 0) + Number(item.discoveryCount || 0);
      summary.seo.rankRuns = Number(summary.seo.rankRuns || 0) + Number(item.rankCount || 0);
      summary.seo.competitors = Number(summary.seo.competitors || 0) + (Array.isArray(item.competitors) ? item.competitors.length : 0);
      if (["ready", "completed", "audited"].includes(String(item.status || "").toLowerCase())) {
        summary.seo.ready += 1;
      }
      if (item.lastAuditAt && (!summary.seo.lastRunAt || item.lastAuditAt > summary.seo.lastRunAt)) {
        summary.seo.lastRunAt = item.lastAuditAt;
      }
      if (item.lastDiscoveryAt && (!summary.seo.lastRunAt || item.lastDiscoveryAt > summary.seo.lastRunAt)) {
        summary.seo.lastRunAt = item.lastDiscoveryAt;
      }
      if (item.lastRankAt && (!summary.seo.lastRunAt || item.lastRankAt > summary.seo.lastRunAt)) {
        summary.seo.lastRunAt = item.lastRankAt;
      }
    }
    if (id === "kanban") {
      summary.kanban = summary.kanban || {
        pendingApprovals: 0,
        workflowCards: 0,
        schedulerCards: 0,
        completed: 0
      };
      if (String(item.approvalStatus || item.status || "").toLowerCase() === "pending") {
        summary.kanban.pendingApprovals += 1;
      }
      if (item.workflowId || String(item.sourceType || "").startsWith("workflow")) {
        summary.kanban.workflowCards += 1;
      }
      if (item.schedulerJobId || String(item.sourceType || "").startsWith("scheduler")) {
        summary.kanban.schedulerCards += 1;
      }
      if (["done", "approved", "completed"].includes(String(item.column || item.status || "").toLowerCase())) {
        summary.kanban.completed += 1;
      }
    }
    if (id === "video") {
      summary.video.workerRuns += Number(item.workerRunCount || 0);
      if (String(item.status || "").toLowerCase() === "queued") summary.video.queued += 1;
      if (String(item.status || "").toLowerCase() === "running") summary.video.running += 1;
      if (["inspected", "planned", "ready", "completed"].includes(String(item.status || "").toLowerCase())) {
        summary.video.ready += 1;
      }
      if (["completed", "rendered"].includes(String(item.status || "").toLowerCase())) {
        summary.video.completed += 1;
      }
      if (String(item.status || "").toLowerCase() === "canceled") summary.video.canceled += 1;
      if (item.lastRunAt && (!summary.video.lastRunAt || item.lastRunAt > summary.video.lastRunAt)) {
        summary.video.lastRunAt = item.lastRunAt;
      }
    }
    if (id === "usage-credits") {
      summary.usage.units += Number(item.units || 0);
      summary.usage.estimatedCost += Number(item.estimatedCost || 0);
    }
  }

  summary.usage.estimatedCost = Number(summary.usage.estimatedCost.toFixed(6));
  return summary;
}

function normalizeState(id, data, { publicView = true } = {}) {
  const base = initialState(id);
  const rawItems = Array.isArray(data?.items) ? data.items : [];
  const items = publicView ? publicSelfValue(rawItems) : rawItems;
  return {
    ...base,
    items,
    summary: summarize(id, rawItems),
    updatedAt: data?.updatedAt || null
  };
}

async function readSelfModuleState(id) {
  const file = await fileFor(id);
  return normalizeState(id, await readJson(file, initialState(id)), { publicView: false });
}

export async function getSelfModuleState(id) {
  const file = await fileFor(id);
  return normalizeState(id, await readJson(file, initialState(id)));
}

function cleanText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function cleanOptionalText(value) {
  return String(value || "").trim();
}

function buildItem(id, payload = {}) {
  const createdAt = cleanDate(payload.createdAt);
  const title = cleanText(payload.title, `Untitled ${MODULES[id].itemName}`);
  const common = {
    id: idFor(MODULES[id].itemName),
    title,
    createdAt,
    updatedAt: createdAt
  };

  if (id === "goals") {
    return {
      ...common,
      status: cleanText(payload.status, MODULES[id].defaultStatus),
      objective: cleanText(payload.objective || payload.title, title),
      notes: cleanText(payload.notes || payload.body),
      plan: Array.isArray(payload.plan) ? payload.plan.map((item) => cleanText(item)).filter(Boolean) : [],
      nextAction: cleanText(payload.nextAction),
      loopCount: Number(payload.loopCount || 0),
      lastRunAt: payload.lastRunAt || null,
      lastRunId: payload.lastRunId || null,
      provider: cleanText(payload.provider),
      model: cleanText(payload.model),
      history: Array.isArray(payload.history) ? payload.history.slice(0, MAX_GOAL_HISTORY) : []
    };
  }

  if (id === "notebook") {
    return {
      ...common,
      body: cleanText(payload.body || payload.notes),
      tags: Array.isArray(payload.tags) ? payload.tags.map((tag) => String(tag).trim()).filter(Boolean) : []
    };
  }

  if (id === "seo") {
    return {
      ...common,
      url: cleanText(payload.url),
      keyword: cleanText(payload.keyword),
      status: cleanText(payload.status, MODULES[id].defaultStatus),
      notes: cleanText(payload.notes || payload.body),
      auditCount: Number(payload.auditCount || 0),
      lastAuditAt: payload.lastAuditAt || null,
      lastAuditId: payload.lastAuditId || null,
      scrapeStatus: cleanText(payload.scrapeStatus),
      provider: cleanText(payload.provider),
      model: cleanText(payload.model),
      score: payload.score == null || payload.score === "" ? null : Number(payload.score),
      recommendations: Array.isArray(payload.recommendations) ? payload.recommendations.map((item) => cleanText(item)).filter(Boolean) : [],
      discoveryCount: Number(payload.discoveryCount || 0),
      rankCount: Number(payload.rankCount || 0),
      lastDiscoveryAt: payload.lastDiscoveryAt || null,
      lastDiscoveryId: payload.lastDiscoveryId || null,
      lastRankAt: payload.lastRankAt || null,
      lastRankId: payload.lastRankId || null,
      searchStatus: cleanText(payload.searchStatus),
      competitors: Array.isArray(payload.competitors) ? payload.competitors.slice(0, MAX_SEO_COMPETITORS) : [],
      rankSnapshots: Array.isArray(payload.rankSnapshots) ? payload.rankSnapshots.slice(0, MAX_SEO_RANK_SNAPSHOTS) : [],
      seoHistory: Array.isArray(payload.seoHistory) ? payload.seoHistory.slice(0, MAX_SEO_HISTORY) : [],
      discoveryHistory: Array.isArray(payload.discoveryHistory) ? payload.discoveryHistory.slice(0, MAX_SEO_SEARCH_HISTORY) : [],
      rankHistory: Array.isArray(payload.rankHistory) ? payload.rankHistory.slice(0, MAX_SEO_SEARCH_HISTORY) : []
    };
  }

  if (id === "video") {
    return {
      ...common,
      sourcePath: cleanText(payload.sourcePath),
      workflow: cleanText(payload.workflow, "captioning"),
      status: cleanText(payload.status, MODULES[id].defaultStatus),
      notes: cleanText(payload.notes || payload.body),
      jobType: cleanText(payload.jobType, "caption_handoff"),
      captionProvider: cleanSttProvider(payload.captionProvider || "auto"),
      renderPreset: cleanRenderPreset(payload.renderPreset || "copy"),
      outputName: cleanText(payload.outputName),
      captionOutput: cleanOptionalText(payload.captionOutput),
      renderedOutput: cleanOptionalText(payload.renderedOutput),
      lastOperation: cleanOptionalText(payload.lastOperation),
      workerRunCount: Number(payload.workerRunCount || 0),
      lastRunAt: payload.lastRunAt || null,
      lastRunId: payload.lastRunId || null,
      durationSeconds: payload.durationSeconds == null || payload.durationSeconds === "" ? null : Number(payload.durationSeconds),
      hasAudio: payload.hasAudio == null ? null : Boolean(payload.hasAudio),
      hasVideo: payload.hasVideo == null ? null : Boolean(payload.hasVideo),
      width: payload.width == null || payload.width === "" ? null : Number(payload.width),
      height: payload.height == null || payload.height === "" ? null : Number(payload.height),
      frameRate: cleanOptionalText(payload.frameRate),
      probe: payload.probe && typeof payload.probe === "object" ? payload.probe : null,
      captionPlan: payload.captionPlan && typeof payload.captionPlan === "object" ? payload.captionPlan : null,
      renderPlan: payload.renderPlan && typeof payload.renderPlan === "object" ? payload.renderPlan : null,
      videoHistory: Array.isArray(payload.videoHistory) ? payload.videoHistory.slice(0, MAX_VIDEO_HISTORY) : []
    };
  }

  if (id === "kanban") {
    return {
      ...common,
      column: cleanText(payload.column, MODULES[id].defaultColumn),
      status: cleanText(payload.status, cleanText(payload.approvalStatus, "open")),
      notes: cleanText(payload.notes || payload.body),
      priority: cleanOptionalText(payload.priority),
      assignee: cleanOptionalText(payload.assignee),
      dueAt: payload.dueAt ? cleanDate(payload.dueAt) : null,
      sourceType: cleanOptionalText(payload.sourceType),
      sourceId: cleanOptionalText(payload.sourceId),
      workflowId: cleanOptionalText(payload.workflowId),
      runId: cleanOptionalText(payload.runId),
      nodeId: cleanOptionalText(payload.nodeId),
      schedulerJobId: cleanOptionalText(payload.schedulerJobId),
      approvalId: cleanOptionalText(payload.approvalId),
      approvalStatus: cleanOptionalText(payload.approvalStatus),
      approvalRequestedAt: payload.approvalRequestedAt ? cleanDate(payload.approvalRequestedAt) : null,
      approvedAt: payload.approvedAt ? cleanDate(payload.approvedAt) : null,
      rejectedAt: payload.rejectedAt ? cleanDate(payload.rejectedAt) : null,
      completedAt: payload.completedAt ? cleanDate(payload.completedAt) : null,
      linkedModule: cleanOptionalText(payload.linkedModule),
      linkedItemId: cleanOptionalText(payload.linkedItemId)
    };
  }

  if (id === "usage-credits") {
    return {
      ...common,
      provider: cleanText(payload.provider, "manual"),
      model: cleanText(payload.model),
      operation: cleanText(payload.operation, "manual"),
      units: Number(payload.units || 0),
      inputTokens: Number(payload.inputTokens || 0),
      outputTokens: Number(payload.outputTokens || 0),
      estimatedCost: Number(payload.estimatedCost || payload.cost || 0),
      mode: cleanText(payload.mode, payload.dryRun ? "dry_run" : "manual"),
      dryRun: Boolean(payload.dryRun),
      source: cleanText(payload.source),
      requestId: cleanText(payload.requestId),
      sourceId: cleanText(payload.sourceId),
      importId: cleanText(payload.importId),
      invoiceId: cleanText(payload.invoiceId),
      currency: cleanText(payload.currency, "usd").toLowerCase(),
      importedAt: cleanText(payload.importedAt),
      notes: cleanText(payload.notes || payload.body),
      status: cleanText(payload.status, "recorded")
    };
  }

  return common;
}

export async function createSelfModuleItem(id, payload = {}) {
  const current = await readSelfModuleState(id);
  const item = buildItem(id, payload);
  const next = {
    ...current,
    items: [item, ...current.items],
    updatedAt: item.updatedAt
  };
  const file = await fileFor(id);
  await writeJson(file, next);
  await appendModuleLog(id, {
    message: `${MODULES[id].label} ${MODULES[id].itemName} saved`,
    details: {
      itemId: item.id,
      itemName: MODULES[id].itemName,
      summary: summarize(id, next.items)
    }
  });
  return normalizeState(id, next);
}

function compactMatch(input = {}) {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key, value]) => KANBAN_MATCH_KEYS.includes(key) && cleanOptionalText(value))
      .map(([key, value]) => [key, cleanOptionalText(value)])
  );
}

function kanbanCardMatches(card, match = {}) {
  const entries = Object.entries(compactMatch(match));
  if (!entries.length) return false;
  return entries.every(([key, value]) => cleanOptionalText(card[key]) === value);
}

export async function upsertKanbanCard(payload = {}, matchInput = null) {
  const current = await readSelfModuleState("kanban");
  const match = compactMatch(matchInput || payload);
  const index = current.items.findIndex((item) => kanbanCardMatches(item, match));
  const timestamp = cleanDate(payload.updatedAt);
  let card;
  let created = false;
  if (index >= 0) {
    const existing = current.items[index];
    const built = buildItem("kanban", {
      ...existing,
      ...payload,
      createdAt: existing.createdAt,
      updatedAt: timestamp
    });
    card = {
      ...built,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: timestamp
    };
    current.items[index] = card;
  } else {
    card = buildItem("kanban", { ...payload, updatedAt: timestamp });
    current.items = [card, ...current.items];
    created = true;
  }
  const next = {
    ...current,
    updatedAt: timestamp
  };
  const file = await fileFor("kanban");
  await writeJson(file, next);
  await appendModuleLog("kanban", {
    message: created ? "Kanban card created by automation hook" : "Kanban card updated by automation hook",
    details: {
      cardId: card.id,
      column: card.column,
      status: card.status,
      sourceType: card.sourceType,
      workflowId: card.workflowId,
      runId: card.runId,
      nodeId: card.nodeId,
      schedulerJobId: card.schedulerJobId
    }
  });
  return {
    created,
    card: publicSelfValue(card),
    state: normalizeState("kanban", next)
  };
}

export async function updateKanbanCards(match = {}, patch = {}) {
  const current = await readSelfModuleState("kanban");
  const timestamp = cleanDate(patch.updatedAt);
  const cards = [];
  const items = current.items.map((item) => {
    if (!kanbanCardMatches(item, match)) return item;
    const built = buildItem("kanban", {
      ...item,
      ...patch,
      createdAt: item.createdAt,
      updatedAt: timestamp
    });
    const updated = {
      ...built,
      id: item.id,
      createdAt: item.createdAt,
      updatedAt: timestamp
    };
    cards.push(updated);
    return updated;
  });
  if (!cards.length) {
    return {
      count: 0,
      cards: [],
      state: normalizeState("kanban", current)
    };
  }
  const next = {
    ...current,
    items,
    updatedAt: timestamp
  };
  const file = await fileFor("kanban");
  await writeJson(file, next);
  await appendModuleLog("kanban", {
    message: "Kanban cards updated by automation hook",
    details: {
      count: cards.length,
      match: compactMatch(match),
      column: patch.column || "",
      status: patch.status || "",
      approvalStatus: patch.approvalStatus || ""
    }
  });
  return {
    count: cards.length,
    cards: publicSelfValue(cards),
    state: normalizeState("kanban", next)
  };
}

export async function getLocalSelfModuleStatus(id) {
  const state = await getSelfModuleState(id);
  return {
    itemCount: state.items.length,
    updatedAt: state.updatedAt,
    summary: state.summary
  };
}

function videoToolEnvKey(tool) {
  if (tool === "ffprobe") return "HERMES_FFPROBE_PATH";
  if (tool === "ffmpeg") return "HERMES_FFMPEG_PATH";
  if (tool === "whisper") return "HERMES_WHISPER_PATH";
  return "";
}

async function videoToolStatus(tool, versionArgs = ["-version"]) {
  const configured = process.env[videoToolEnvKey(tool)] || "";
  const command = configured || await which(tool);
  const version = command ? await commandVersion(command, versionArgs) : null;
  return {
    id: tool,
    available: Boolean(command),
    configured: Boolean(command),
    command: tool,
    configuredByEnv: Boolean(configured),
    version: version ? redactText(String(version).split(/\r?\n/)[0]).slice(0, 160) : null
  };
}

function sttProviderLabel(provider) {
  if (provider === "groq") return "Groq";
  if (provider === "openai") return "OpenAI";
  if (provider === "whisper") return "Local Whisper";
  return "Auto";
}

function videoSttPreferredProvider() {
  const provider = String(process.env.HERMES_VIDEO_STT_PROVIDER || "auto").trim().toLowerCase();
  return ["auto", "groq", "openai", "whisper"].includes(provider) ? provider : "auto";
}

function videoSttModel(provider) {
  if (provider === "groq") return process.env.HERMES_VIDEO_GROQ_STT_MODEL || "whisper-large-v3-turbo";
  if (provider === "openai") return process.env.HERMES_VIDEO_OPENAI_STT_MODEL || "whisper-1";
  return "local-whisper";
}

function videoSttEndpoint(provider) {
  if (provider === "groq") return process.env.HERMES_GROQ_STT_URL || "https://api.groq.com/openai/v1/audio/transcriptions";
  if (provider === "openai") return process.env.HERMES_OPENAI_STT_URL || "https://api.openai.com/v1/audio/transcriptions";
  return "";
}

function videoSttApiKey(stored, provider) {
  if (provider === "groq") {
    return process.env.GROQ_API_KEY || getConfiguredValue(stored, "firecrawl-builder", "GROQ_API_KEY");
  }
  if (provider === "openai") {
    return process.env.OPENAI_API_KEY
      || getConfiguredValue(stored, "provider-openai", "OPENAI_API_KEY")
      || getConfiguredValue(stored, "codex", "OPENAI_API_KEY")
      || getConfiguredValue(stored, "firecrawl-builder", "OPENAI_API_KEY");
  }
  return null;
}

async function getVideoSttProviderStatus(whisperTool = null) {
  const stored = await getStoredConnectionConfig();
  const preferred = videoSttPreferredProvider();
  const providers = VIDEO_CLOUD_STT_PROVIDERS.map((provider) => {
    const hasKey = Boolean(videoSttApiKey(stored, provider));
    return {
      id: provider,
      label: sttProviderLabel(provider),
      status: hasKey ? "connected" : "ready_to_configure",
      configured: hasKey,
      missing: hasKey ? [] : [`${provider.toUpperCase()}_API_KEY`],
      model: videoSttModel(provider),
      endpoint: videoSttEndpoint(provider).replace(/^https?:\/\/([^/]+).*/, "https://$1/..."),
      publicSummary: hasKey
        ? `${sttProviderLabel(provider)} STT is configured for cloud transcription.`
        : `Configure ${provider.toUpperCase()}_API_KEY to enable ${sttProviderLabel(provider)} cloud transcription.`
    };
  });
  const whisper = {
    id: "whisper",
    label: "Local Whisper",
    status: whisperTool?.available ? "connected" : "ready_to_configure",
    configured: Boolean(whisperTool?.available),
    missing: whisperTool?.available ? [] : ["whisper"],
    model: "local-whisper",
    endpoint: "local command",
    publicSummary: whisperTool?.available
      ? "Local Whisper is available as the offline fallback."
      : "Install Whisper or set HERMES_WHISPER_PATH to enable local fallback."
  };
  const configuredCloud = providers.find((provider) => provider.configured);
  const defaultProvider = preferred !== "auto"
    ? preferred
    : configuredCloud?.id || (whisper.configured ? "whisper" : null);
  return {
    preferred,
    defaultProvider,
    configured: Boolean(defaultProvider),
    providers: [...providers, whisper],
    missing: defaultProvider ? [] : ["GROQ_API_KEY or OPENAI_API_KEY or whisper"]
  };
}

export async function getVideoWorkerStatus() {
  const [ffprobe, ffmpeg, whisper] = await Promise.all([
    videoToolStatus("ffprobe"),
    videoToolStatus("ffmpeg"),
    videoToolStatus("whisper", ["--help"])
  ]);
  const tools = { ffprobe, ffmpeg, whisper };
  const stt = await getVideoSttProviderStatus(whisper);
  const missing = Object.values(tools).filter((tool) => !tool.available).map((tool) => tool.id);
  return {
    id: "video-worker",
    status: ffprobe.available ? "connected" : "ready_to_configure",
    configured: ffprobe.available,
    missing,
    execEnabled: await isExecutionEnabled(),
    tools,
    capabilities: [
      "ffprobe-inspection",
      "caption-handoff",
      "render-handoff",
      "cloud-stt",
      "groq-stt",
      "openai-stt",
      "whisper-transcription",
      "ffmpeg-render",
      "caption-render",
      "queue",
      "progress-polling",
      "ffmpeg-progress-parsing",
      "whisper-progress-parsing",
      "cancel-run",
      "safe-output-download",
      "execution-gated-manifest",
      "redacted-paths"
    ],
    stt,
    publicSummary: ffprobe.available
      ? "Video worker can inspect local media, queue runs, dry-run plans, execute gated Groq/OpenAI/local Whisper transcription, run ffmpeg, parse command progress, and serve safe output downloads."
      : "Install ffprobe or set HERMES_FFPROBE_PATH before inspecting local video jobs."
  };
}

function parseFrameRate(value) {
  const text = cleanOptionalText(value);
  if (!text || !text.includes("/")) return text;
  const [left, right] = text.split("/").map(Number);
  if (!Number.isFinite(left) || !Number.isFinite(right) || right === 0) return text;
  return (left / right).toFixed(3).replace(/\.?0+$/, "");
}

function publicSourceLabel(sourcePath) {
  if (!sourcePath) return "";
  const base = path.basename(String(sourcePath));
  return base ? `{{SOURCE_VIDEO}}/${base}` : "{{SOURCE_VIDEO}}";
}

function publicVideoRunPath(runId, file = "") {
  return ["~/.hermes-agent-os/runs/video", runId, file].filter(Boolean).join("/");
}

function cleanVideoOperation(value) {
  const operation = cleanOptionalText(value || "handoff").toLowerCase().replaceAll("-", "_");
  return VIDEO_OPERATIONS.has(operation) ? operation : "handoff";
}

function cleanSttProvider(value) {
  const provider = cleanOptionalText(value || "auto").toLowerCase().replaceAll("-", "_");
  return ["auto", "groq", "openai", "whisper"].includes(provider) ? provider : "auto";
}

function cleanRenderPreset(value) {
  const preset = cleanOptionalText(value || "copy").toLowerCase().replaceAll("-", "_");
  return VIDEO_RENDER_PRESETS[preset] ? preset : "copy";
}

function videoNeedsCaptionStep(operation) {
  return operation === "transcribe" || operation === "caption_render";
}

function videoNeedsRenderStep(operation) {
  return operation === "render" || operation === "caption_render";
}

function safeFileStem(value, fallback = "video") {
  const source = path.basename(String(value || fallback), path.extname(String(value || "")));
  return source.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || fallback;
}

function safeOutputName(value, fallback) {
  const base = path.basename(String(value || fallback));
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return cleaned || fallback;
}

function escapeFfmpegFilterPath(filePath) {
  return String(filePath || "")
    .replaceAll("\\", "/")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'");
}

function publicRenderPresets() {
  return Object.values(VIDEO_RENDER_PRESETS).map((preset) => ({
    id: preset.id,
    label: preset.label,
    summary: preset.summary,
    transcode: preset.transcode,
    commandTemplate: preset.commandTemplate
  }));
}

function outputNameForPreset(job, operation, stem, preset) {
  const definition = VIDEO_RENDER_PRESETS[preset] || VIDEO_RENDER_PRESETS.copy;
  const defaultName = operation === "caption_render"
    ? `${stem}-${definition.outputSuffix}-captioned.mp4`
    : `${stem}-${definition.outputSuffix}.mp4`;
  return safeOutputName(job.outputName, defaultName);
}

function buildVideoFilter({ preset, captionFile }) {
  const definition = VIDEO_RENDER_PRESETS[preset] || VIDEO_RENDER_PRESETS.copy;
  const filters = [];
  if (definition.filter) filters.push(definition.filter);
  if (captionFile) filters.push(`subtitles='${escapeFfmpegFilterPath(captionFile)}'`);
  return filters.join(",");
}

function buildFfmpegRenderArgs({ operation, preset, expandedSourcePath, captionFile, renderedFile }) {
  const definition = VIDEO_RENDER_PRESETS[preset] || VIDEO_RENDER_PRESETS.copy;
  const needsCaptionBurn = operation === "caption_render";
  const filter = buildVideoFilter({ preset, captionFile: needsCaptionBurn ? captionFile : null });
  if (!definition.transcode && !needsCaptionBurn) {
    return [
      "-y",
      "-i", expandedSourcePath,
      "-map", "0",
      "-c", "copy",
      "-movflags", "+faststart",
      renderedFile
    ];
  }
  const args = [
    "-y",
    "-i", expandedSourcePath
  ];
  if (filter) args.push("-vf", filter);
  args.push(
    "-map", "0:v:0",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    renderedFile
  );
  return args;
}

async function findFirstFile(dir, extension) {
  try {
    const files = await fs.readdir(dir);
    const match = files.find((file) => file.toLowerCase().endsWith(extension));
    return match ? path.join(dir, match) : null;
  } catch {
    return null;
  }
}

function secondsFromFfmpegTime(value) {
  const match = String(value || "").match(/(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Number(number.toFixed(2))));
}

function commandProgressRange(operation, commandName) {
  if (operation === "caption_render" && String(commandName || "").includes("stt")) return [20, 55];
  if (operation === "caption_render" && commandName === "whisper") return [20, 55];
  if (String(commandName || "").includes("stt")) return [20, 95];
  if (operation === "caption_render" && commandName === "ffmpeg") return [55, 95];
  if (commandName === "whisper") return [20, 95];
  if (commandName === "ffmpeg") return [20, 95];
  return [20, 95];
}

function globalProgressForCommand(operation, commandName, commandPercent) {
  const [start, end] = commandProgressRange(operation, commandName);
  const local = clampPercent(commandPercent);
  if (local == null) return start;
  return clampPercent(start + ((end - start) * (local / 100)));
}

function parseVideoCommandProgress({ name, operation, chunk, stream, probe, redactions = [] }) {
  const text = redactText(chunk, redactions);
  const samples = [];
  const push = (percent, source, extra = {}) => {
    const localPercent = clampPercent(percent);
    if (localPercent == null) return;
    samples.push({
      at: now(),
      command: name,
      stream,
      source,
      percent: localPercent,
      runProgress: globalProgressForCommand(operation, name, localPercent),
      text: cleanOptionalText(text).slice(0, 180),
      ...extra
    });
  };
  const explicitProgress = text.match(/(?:^|[\s,])progress[=:]\s*(\d{1,3}(?:\.\d+)?)%?/i);
  if (explicitProgress) push(explicitProgress[1], "progress");
  const percentMatches = [...text.matchAll(/(^|[^\d])(\d{1,3}(?:\.\d+)?)%/g)];
  for (const match of percentMatches) push(match[2], "percent");
  const timeMatches = [...text.matchAll(/time=\s*(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)/g)];
  const duration = Number(probe?.durationSeconds || 0);
  if (duration > 0) {
    for (const match of timeMatches) {
      const seconds = secondsFromFfmpegTime(match[1]);
      if (seconds != null) push((seconds / duration) * 100, "ffmpeg-time", { seconds });
    }
    const outTimeMs = text.match(/out_time_ms=(\d+)/);
    if (outTimeMs) {
      const seconds = Number(outTimeMs[1]) / 1000000;
      push((seconds / duration) * 100, "ffmpeg-progress", { seconds });
    }
  }
  if (/progress=end/i.test(text)) push(100, "ffmpeg-progress-end");
  return samples;
}

function progressDetails({ stage, currentCommand = null, commandProgress = null, samples = [] }) {
  return {
    stage,
    currentCommand,
    commandProgress,
    samples: samples.slice(-20)
  };
}

async function runVideoCommand({ name, command, args, timeout, redactions, publicOutput, signal, operation, probe, onProgress }) {
  const started = Date.now();
  const progressSamples = [];
  const progressWrites = [];
  const emitProgress = (sample) => {
    const previous = progressSamples[progressSamples.length - 1];
    if (previous && previous.command === sample.command && previous.percent === sample.percent && previous.source === sample.source) return;
    progressSamples.push(sample);
    if (progressSamples.length > 20) progressSamples.shift();
    const write = onProgress?.(sample, progressSamples);
    if (write && typeof write.then === "function") progressWrites.push(write.catch(() => null));
  };
  emitProgress({
    at: now(),
    command: name,
    stream: "system",
    source: "started",
    percent: 0,
    runProgress: globalProgressForCommand(operation, name, 0),
    text: `${name} started`
  });
  const handleChunk = (stream, chunk) => {
    for (const sample of parseVideoCommandProgress({ name, operation, chunk, stream, probe, redactions })) {
      emitProgress(sample);
    }
  };
  const result = await runStreamingCommand(command, args, timeout, {
    signal,
    onStdout: (chunk) => handleChunk("stdout", chunk),
    onStderr: (chunk) => handleChunk("stderr", chunk)
  });
  emitProgress({
    at: now(),
    command: name,
    stream: "system",
    source: result.ok && !result.aborted ? "completed" : result.aborted ? "canceled" : "finished",
    percent: result.ok && !result.aborted ? 100 : progressSamples[progressSamples.length - 1]?.percent || 0,
    runProgress: result.ok && !result.aborted ? globalProgressForCommand(operation, name, 100) : progressSamples[progressSamples.length - 1]?.runProgress || globalProgressForCommand(operation, name, 0),
    text: `${name} ${result.ok && !result.aborted ? "completed" : result.aborted ? "canceled" : "finished"}`
  });
  await Promise.all(progressWrites);
  const completed = Date.now();
  return {
    name,
    ok: result.ok && !result.aborted,
    status: result.aborted ? "canceled" : result.ok ? "completed" : "error",
    code: result.code,
    signal: result.signal,
    durationMs: completed - started,
    stdout: redactText(result.stdout, redactions).slice(0, 2000),
    stderr: redactText(result.stderr, redactions).slice(0, 2000),
    output: publicOutput || null,
    progressSamples: progressSamples.slice(-20)
  };
}

function srtTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function textToSrt(text, durationSeconds = null) {
  const clean = cleanOptionalText(text || "Transcription completed.");
  const end = Number(durationSeconds || 0) > 0 ? Number(durationSeconds) : 3;
  return `1\n${srtTimestamp(0)} --> ${srtTimestamp(end)}\n${clean || "Transcription completed."}\n`;
}

function segmentsToSrt(segments = [], fallbackText = "", durationSeconds = null) {
  const usable = Array.isArray(segments)
    ? segments
        .map((segment) => ({
          start: Number(segment.start ?? segment.startTime ?? 0),
          end: Number(segment.end ?? segment.endTime ?? 0),
          text: cleanOptionalText(segment.text || segment.transcript || "")
        }))
        .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text)
    : [];
  if (!usable.length) return textToSrt(fallbackText, durationSeconds);
  return `${usable.map((segment, index) => [
    String(index + 1),
    `${srtTimestamp(segment.start)} --> ${srtTimestamp(segment.end)}`,
    segment.text
  ].join("\n")).join("\n\n")}\n`;
}

function normalizeSttResponseToSrt(raw, durationSeconds = null) {
  const text = String(raw || "").trim();
  if (/^\s*\d+\s*\r?\n\d{2}:\d{2}:\d{2},\d{3}\s+-->/m.test(text)) return `${text}\n`;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed.segments)) return segmentsToSrt(parsed.segments, parsed.text, durationSeconds);
    if (Array.isArray(parsed.words)) return segmentsToSrt(parsed.words, parsed.text, durationSeconds);
    return textToSrt(parsed.text || parsed.transcript || parsed.response || text, durationSeconds);
  } catch {
    return textToSrt(text, durationSeconds);
  }
}

function contentTypeForVideoSource(sourcePath) {
  const ext = path.extname(String(sourcePath || "")).toLowerCase();
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".webm") return "audio/webm";
  if (ext === ".mp4" || ext === ".mov" || ext === ".m4v") return "video/mp4";
  return "application/octet-stream";
}

function sttProviderOrder(preferred, sttStatus) {
  const configured = new Set((sttStatus.providers || []).filter((provider) => provider.configured).map((provider) => provider.id));
  const order = preferred && preferred !== "auto" ? [preferred] : ["groq", "openai", "whisper"];
  for (const provider of ["groq", "openai", "whisper"]) {
    if (!order.includes(provider)) order.push(provider);
  }
  return order.filter((provider) => configured.has(provider));
}

async function recordVideoSttUsage({ provider, model, sourceBytes, outputText, status, runId }) {
  try {
    const { recordUsageEvent } = await import("./usage.js");
    await recordUsageEvent({
      provider,
      model,
      operation: "video_stt",
      source: "video-worker",
      requestId: runId,
      units: Math.max(1, Math.ceil(Number(sourceBytes || 0) / 1024)),
      outputText,
      mode: "executed",
      status,
      title: `Video STT ${provider} ${status}`
    });
  } catch {
    // Usage recording must not make a completed transcription fail.
  }
}

async function runCloudSttProvider({ provider, runId, runDir, sourcePath, expandedSourcePath, probe, redactions, signal, operation, onProgress }) {
  const stored = await getStoredConnectionConfig();
  const apiKey = videoSttApiKey(stored, provider);
  const endpoint = videoSttEndpoint(provider);
  const model = videoSttModel(provider);
  const started = Date.now();
  const name = `${provider}-stt`;
  const progressSamples = [];
  const emit = async (percent, source, text) => {
    const sample = {
      at: now(),
      command: name,
      stream: "system",
      source,
      percent: clampPercent(percent) ?? 0,
      runProgress: globalProgressForCommand(operation, name, percent),
      text: cleanOptionalText(text).slice(0, 180)
    };
    progressSamples.push(sample);
    if (progressSamples.length > 20) progressSamples.shift();
    await onProgress?.(sample, progressSamples);
  };
  if (!apiKey) {
    return {
      name,
      ok: false,
      status: "ready_to_configure",
      code: "missing_key",
      signal: null,
      durationMs: 0,
      stdout: "",
      stderr: `${sttProviderLabel(provider)} STT needs ${provider.toUpperCase()}_API_KEY.`,
      output: null,
      progressSamples
    };
  }

  await emit(0, "started", `${sttProviderLabel(provider)} STT started`);
  const stat = await fs.stat(expandedSourcePath);
  const maxMb = Number(process.env.HERMES_VIDEO_CLOUD_STT_MAX_MB || 100);
  if (Number.isFinite(maxMb) && maxMb > 0 && stat.size > maxMb * 1024 * 1024) {
    await emit(100, "skipped", `${sttProviderLabel(provider)} STT skipped because source exceeds cloud upload limit`);
    return {
      name,
      ok: false,
      status: "ready_to_configure",
      code: "file_too_large",
      signal: null,
      durationMs: Date.now() - started,
      stdout: "",
      stderr: `Source exceeds HERMES_VIDEO_CLOUD_STT_MAX_MB (${maxMb} MB).`,
      output: null,
      progressSamples
    };
  }

  const timeoutMs = Number(process.env.HERMES_VIDEO_STT_TIMEOUT_MS || process.env.HERMES_VIDEO_WHISPER_TIMEOUT_MS || 600000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener?.("abort", abort, { once: true });
  try {
    await emit(15, "uploading", `${sttProviderLabel(provider)} STT uploading source`);
    const fileBuffer = await fs.readFile(expandedSourcePath);
    const form = new FormData();
    form.set("file", new File([fileBuffer], path.basename(expandedSourcePath), { type: contentTypeForVideoSource(expandedSourcePath) }));
    form.set("model", model);
    if (provider === "openai") {
      form.set("response_format", "srt");
    } else {
      form.set("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
    }
    const language = cleanOptionalText(process.env.HERMES_VIDEO_STT_LANGUAGE || "");
    if (language) form.set("language", language);
    await emit(35, "request", `${sttProviderLabel(provider)} STT request sent`);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) {
      await emit(100, "error", `${sttProviderLabel(provider)} STT failed`);
      return {
        name,
        ok: false,
        status: controller.signal.aborted ? "canceled" : "error",
        code: response.status,
        signal: controller.signal.aborted ? "SIGTERM" : null,
        durationMs: Date.now() - started,
        stdout: "",
        stderr: redactText(body || response.statusText, [...redactions, apiKey]).slice(0, 2000),
        output: null,
        progressSamples
      };
    }
    const srt = normalizeSttResponseToSrt(body, probe?.durationSeconds);
    const outputPath = path.join(runDir, `${safeFileStem(sourcePath, "video")}.srt`);
    await fs.writeFile(outputPath, srt);
    await emit(100, "completed", `${sttProviderLabel(provider)} STT completed`);
    await recordVideoSttUsage({
      provider,
      model,
      sourceBytes: stat.size,
      outputText: srt,
      status: "completed",
      runId
    });
    return {
      name,
      ok: true,
      status: "completed",
      code: response.status,
      signal: null,
      durationMs: Date.now() - started,
      stdout: `${sttProviderLabel(provider)} transcription completed.`,
      stderr: "",
      output: publicVideoRunPath(runId, path.basename(outputPath)),
      progressSamples,
      provider,
      model
    };
  } catch (error) {
    await emit(100, controller.signal.aborted ? "canceled" : "error", `${sttProviderLabel(provider)} STT ${controller.signal.aborted ? "canceled" : "failed"}`);
    return {
      name,
      ok: false,
      status: controller.signal.aborted ? "canceled" : "error",
      code: controller.signal.aborted ? "aborted" : "request_failed",
      signal: controller.signal.aborted ? "SIGTERM" : null,
      durationMs: Date.now() - started,
      stdout: "",
      stderr: redactText(error instanceof Error ? error.message : "Cloud STT request failed.", [...redactions, apiKey]).slice(0, 2000),
      output: null,
      progressSamples,
      provider,
      model
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", abort);
  }
}

function videoExecutionMissing(operation, plans) {
  const missing = [];
  if (videoNeedsCaptionStep(operation)) missing.push(...(plans.captionPlan.missing || []));
  if (videoNeedsRenderStep(operation)) missing.push(...(plans.renderPlan.missing || []));
  return Array.from(new Set(missing));
}

async function executeVideoOperations({ operation, runId, runDir, job, sourcePath, expandedSourcePath, plans, probe, signal, onProgress }) {
  await fs.mkdir(runDir, { recursive: true });
  const redactions = [
    sourcePath,
    expandedSourcePath,
    runDir,
    process.env.HERMES_WHISPER_PATH,
    process.env.HERMES_FFMPEG_PATH
  ].filter(Boolean);
  const stem = safeFileStem(sourcePath || job.title, "video");
  const commands = [];
  let captionFile = null;
  let renderedFile = null;

  if (signal?.aborted) {
    return {
      ok: false,
      status: "canceled",
      message: "Video run canceled before command execution.",
      captionFile: null,
      renderedFile: null,
      commands
    };
  }

  if (videoNeedsCaptionStep(operation)) {
    const expectedCaption = path.join(runDir, `${stem}.srt`);
    const preferredSttProvider = cleanSttProvider(plans.captionPlan.provider || job.captionProvider || "auto");
    const sttOrder = sttProviderOrder(preferredSttProvider, plans.captionPlan.stt || { providers: [] });
    let captionResult = null;
    for (const provider of sttOrder) {
      if (signal?.aborted) break;
      if (provider === "whisper") {
        const whisperCommand = process.env.HERMES_WHISPER_PATH || await which("whisper");
        captionResult = await runVideoCommand({
          name: "whisper",
          command: whisperCommand,
          args: [expandedSourcePath, "--output_format", "srt", "--output_dir", runDir],
          timeout: Number(process.env.HERMES_VIDEO_WHISPER_TIMEOUT_MS || 600000),
          redactions,
          publicOutput: publicVideoRunPath(runId, `${stem}.srt`),
          signal,
          operation,
          probe,
          onProgress
        });
      } else {
        captionResult = await runCloudSttProvider({
          provider,
          runId,
          runDir,
          sourcePath,
          expandedSourcePath,
          probe,
          redactions,
          signal,
          operation,
          onProgress
        });
      }
      commands.push(captionResult);
      if (captionResult.ok || captionResult.status === "canceled") break;
    }
    if (!captionResult) {
      return {
        ok: false,
        status: "ready_to_configure",
        message: "Captioning needs Groq/OpenAI cloud STT or local Whisper.",
        captionFile: null,
        renderedFile: null,
        commands
      };
    }
    if (captionResult.status === "canceled") {
      return {
        ok: false,
        status: "canceled",
        message: `${sttProviderLabel(captionResult.provider || "whisper")} transcription was canceled.`,
        captionFile: null,
        renderedFile: null,
        commands
      };
    }
    if (!captionResult.ok) {
      return {
        ok: false,
        status: "error",
        message: "All configured transcription providers failed.",
        captionFile: null,
        renderedFile: null,
        commands
      };
    }
    captionFile = await findFirstFile(runDir, ".srt");
    if (!captionFile && await fileExists(expectedCaption)) captionFile = expectedCaption;
    if (!captionFile) {
      return {
        ok: false,
        status: "error",
        message: "Transcription completed but no SRT file was produced.",
        captionFile: null,
        renderedFile: null,
        commands
      };
    }
  }

  if (signal?.aborted) {
    return {
      ok: false,
      status: "canceled",
      message: "Video run canceled before rendering.",
      captionFile,
      renderedFile: null,
      commands
    };
  }

  if (videoNeedsRenderStep(operation)) {
    const ffmpegCommand = process.env.HERMES_FFMPEG_PATH || await which("ffmpeg");
    const renderPreset = plans.renderPlan.preset || cleanRenderPreset(job.renderPreset || "copy");
    const outputName = outputNameForPreset(job, operation, stem, renderPreset);
    renderedFile = path.join(runDir, outputName);
    const args = buildFfmpegRenderArgs({
      operation,
      preset: renderPreset,
      expandedSourcePath,
      captionFile,
      renderedFile
    });
    const renderResult = await runVideoCommand({
      name: "ffmpeg",
      command: ffmpegCommand,
      args,
      timeout: Number(process.env.HERMES_VIDEO_FFMPEG_TIMEOUT_MS || 600000),
      redactions: [...redactions, captionFile, renderedFile],
      publicOutput: publicVideoRunPath(runId, outputName),
      signal,
      operation,
      probe,
      onProgress
    });
    renderResult.preset = renderPreset;
    commands.push(renderResult);
    if (renderResult.status === "canceled") {
      return {
        ok: false,
        status: "canceled",
        message: "ffmpeg render was canceled.",
        captionFile,
        renderedFile: null,
        commands
      };
    }
    if (!renderResult.ok) {
      return {
        ok: false,
        status: "error",
        message: "ffmpeg render failed.",
        captionFile,
        renderedFile: null,
        commands
      };
    }
    if (!await fileExists(renderedFile)) {
      return {
        ok: false,
        status: "error",
        message: "ffmpeg completed but no rendered MP4 was produced.",
        captionFile,
        renderedFile: null,
        commands
      };
    }
  }

  return {
    ok: true,
    status: "completed",
    message: operation === "handoff"
      ? "Video worker handoff manifest written."
      : operation === "transcribe"
        ? "Video transcription completed."
        : operation === "render"
          ? "ffmpeg render completed."
          : "Video transcription and caption render completed.",
    captionFile,
    renderedFile,
    commands,
    probe
  };
}

function summarizeProbe(raw = {}) {
  const streams = Array.isArray(raw.streams) ? raw.streams : [];
  const format = raw.format && typeof raw.format === "object" ? raw.format : {};
  const videoStream = streams.find((stream) => stream.codec_type === "video") || {};
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
  const subtitleStreams = streams.filter((stream) => stream.codec_type === "subtitle");
  return {
    durationSeconds: format.duration == null ? null : Number(Number(format.duration).toFixed(3)),
    formatName: cleanOptionalText(format.format_name),
    sizeBytes: format.size == null ? null : Number(format.size),
    bitRate: format.bit_rate == null ? null : Number(format.bit_rate),
    hasVideo: Boolean(videoStream.codec_type),
    hasAudio: audioStreams.length > 0,
    hasSubtitles: subtitleStreams.length > 0,
    videoStreams: streams.filter((stream) => stream.codec_type === "video").length,
    audioStreams: audioStreams.length,
    subtitleStreams: subtitleStreams.length,
    width: videoStream.width == null ? null : Number(videoStream.width),
    height: videoStream.height == null ? null : Number(videoStream.height),
    frameRate: parseFrameRate(videoStream.avg_frame_rate || videoStream.r_frame_rate),
    videoCodec: cleanOptionalText(videoStream.codec_name),
    audioCodecs: Array.from(new Set(audioStreams.map((stream) => cleanOptionalText(stream.codec_name)).filter(Boolean)))
  };
}

async function probeVideoSource(sourcePath, ffprobeCommand) {
  const result = await runCommand(ffprobeCommand, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    sourcePath
  ], 30000);
  if (!result.ok || !result.stdout) {
    return {
      ok: false,
      status: "error",
      message: result.stderr || result.stdout || "ffprobe failed to inspect the source video.",
      probe: null
    };
  }
  try {
    const raw = JSON.parse(result.stdout);
    return {
      ok: true,
      status: "completed",
      message: "ffprobe inspection completed.",
      probe: summarizeProbe(raw)
    };
  } catch (error) {
    return {
      ok: false,
      status: "error",
      message: `ffprobe returned invalid JSON: ${error.message}`,
      probe: null
    };
  }
}

function buildVideoPlans(job, probe, worker, input = {}) {
  const captionRequested = !String(job.workflow || "").trim() || /caption|subtitle|transcri/i.test(String(job.workflow || "")) || input.caption !== false;
  const captionProvider = cleanSttProvider(input.captionProvider || job.captionProvider || worker.stt?.preferred || "auto");
  const stt = worker.stt || { providers: [], configured: false, defaultProvider: null };
  const sttOrder = sttProviderOrder(captionProvider, stt);
  const configuredProvider = sttOrder[0] || null;
  const captionMissing = [];
  if (captionRequested && !probe?.hasAudio) captionMissing.push("audio_stream");
  if (captionRequested && !configuredProvider) {
    if (captionProvider === "auto") captionMissing.push("GROQ_API_KEY or OPENAI_API_KEY or whisper");
    else captionMissing.push(captionProvider === "whisper" ? "whisper" : `${captionProvider.toUpperCase()}_API_KEY`);
  }
  const captionCommand = configuredProvider && configuredProvider !== "whisper"
    ? `${configuredProvider} cloud STT {{SOURCE_VIDEO}} -> {{OUTPUT_SRT}}`
    : "whisper {{SOURCE_VIDEO}} --output_format srt --output_dir {{OUTPUT_DIR}}";
  const captionPlan = {
    requested: captionRequested,
    status: !captionRequested ? "not_requested" : captionMissing.length ? "ready_to_configure" : "ready",
    provider: captionProvider,
    resolvedProvider: configuredProvider,
    fallbackOrder: sttOrder,
    stt,
    missing: captionMissing,
    outputFormat: "srt",
    commandTemplate: captionRequested ? captionCommand : "",
    publicSummary: !captionRequested
      ? "Captioning is not requested for this workflow."
      : captionMissing.length
        ? `Caption handoff needs ${captionMissing.join(", ")}.`
        : `Caption handoff is ready through ${sttProviderLabel(configuredProvider)}${sttOrder.length > 1 ? " with fallback" : ""}.`
  };
  const renderMissing = worker.tools.ffmpeg.available ? [] : ["ffmpeg"];
  const renderPreset = cleanRenderPreset(input.renderPreset || job.renderPreset || "copy");
  const renderPresetDefinition = VIDEO_RENDER_PRESETS[renderPreset] || VIDEO_RENDER_PRESETS.copy;
  const renderPlan = {
    requested: true,
    status: renderMissing.length ? "ready_to_configure" : "ready",
    preset: renderPreset,
    presetLabel: renderPresetDefinition.label,
    availablePresets: publicRenderPresets(),
    missing: renderMissing,
    outputFormat: "mp4",
    commandTemplate: renderPresetDefinition.commandTemplate,
    publicSummary: renderMissing.length
      ? "Install ffmpeg or set HERMES_FFMPEG_PATH before rendering."
      : `Render preset ready: ${renderPresetDefinition.summary}`
  };
  return { captionPlan, renderPlan };
}

function videoRunStatus({ sourcePath, sourceExists, worker, probeResult, mode }) {
  if (!sourcePath) return "ready_to_configure";
  if (!worker.tools.ffprobe.available) return "ready_to_configure";
  if (!sourceExists) return "ready_to_configure";
  if (!probeResult.ok) return "error";
  return mode === "executed" ? "completed" : "planned";
}

function videoRunProgress(status) {
  if (status === "queued") return 0;
  if (status === "running") return 15;
  if (status === "cancel_requested") return 90;
  if (VIDEO_TERMINAL_STATUSES.has(status)) return 100;
  return 0;
}

function findVideoRun(state, runId) {
  for (const item of state.items || []) {
    const run = (Array.isArray(item.videoHistory) ? item.videoHistory : []).find((entry) => entry.id === runId);
    if (run) return { job: item, run };
  }
  return null;
}

async function updateVideoRunRecord(runId, updater) {
  const current = await readSelfModuleState("video");
  let updatedRun = null;
  let updatedJob = null;
  const items = current.items.map((item) => {
    const history = Array.isArray(item.videoHistory) ? item.videoHistory : [];
    if (!history.some((entry) => entry.id === runId)) return item;
    const nextHistory = history.map((entry) => {
      if (entry.id !== runId) return entry;
      const nextRun = updater(entry, item);
      updatedRun = nextRun;
      return nextRun;
    });
    updatedJob = {
      ...item,
      status: updatedRun?.status || item.status,
      lastRunAt: updatedRun?.completedAt || updatedRun?.startedAt || updatedRun?.queuedAt || item.lastRunAt || null,
      lastRunId: runId,
      videoHistory: nextHistory
    };
    return updatedJob;
  });
  if (!updatedRun) {
    const error = new Error("video run not found");
    error.status = 404;
    throw error;
  }
  const nextState = {
    ...current,
    items,
    updatedAt: now()
  };
  await writeJson(await fileFor("video"), nextState);
  return {
    ok: true,
    job: publicSelfValue(updatedJob),
    run: publicSelfValue(updatedRun),
    state: normalizeState("video", nextState)
  };
}

export async function getVideoRun(runId) {
  const current = await readSelfModuleState("video");
  const found = findVideoRun(current, runId);
  if (!found) {
    const error = new Error("video run not found");
    error.status = 404;
    throw error;
  }
  return {
    ok: true,
    job: publicSelfValue(found.job),
    run: publicSelfValue(found.run),
    state: normalizeState("video", current)
  };
}

function queuedVideoRun({ runId, jobId, operation, dryRun, queuedAt, worker }) {
  return {
    id: runId,
    jobId,
    status: "queued",
    mode: "queued",
    operation,
    dryRun,
    queuedAt,
    startedAt: null,
    completedAt: null,
    progress: 0,
    cancelRequested: false,
    source: {
      path: "",
      exists: false
    },
    probeStatus: "queued",
    message: "Video run queued.",
    probe: null,
    captionPlan: null,
    renderPlan: null,
    output: {
      directory: publicVideoRunPath(runId),
      manifest: null,
      captions: null,
      renderedVideo: null
    },
    commands: [],
    progressDetails: progressDetails({ stage: "queued" }),
    worker: {
      status: worker.status,
      missing: worker.missing,
      tools: worker.tools
    }
  };
}

function startVideoQueueProcessor() {
  if (videoQueueActive) return;
  videoQueueActive = true;
  setTimeout(async () => {
    try {
      while (videoRunQueue.length) {
        const item = videoRunQueue.shift();
        const controller = new AbortController();
        videoRunControllers.set(item.runId, controller);
        try {
          await withRuntimeHome(item.runtimeHome, async () => {
            const current = await getVideoRun(item.runId);
            if (current.run.status === "canceled" || current.run.cancelRequested) return;
            await updateVideoRunRecord(item.runId, (run) => ({
              ...run,
              status: "running",
              mode: "queued_execution",
              startedAt: now(),
              progress: videoRunProgress("running"),
              progressDetails: progressDetails({ stage: "running", samples: run.progressDetails?.samples || [] }),
              message: "Video run started."
            }));
            await runVideoJob(item.jobId, {
              ...item.input,
              runId: item.runId,
              signal: controller.signal
            });
          });
        } catch (error) {
          if (error?.status !== 404) {
            try {
              await withRuntimeHome(item.runtimeHome, async () => {
                await updateVideoRunRecord(item.runId, (run) => ({
                  ...run,
                  status: "error",
                  completedAt: now(),
                  progress: 100,
                  message: error instanceof Error ? error.message : "Queued video run failed."
                }));
              });
            } catch {
              // The run may have been deleted from local state.
            }
          }
        } finally {
          videoRunControllers.delete(item.runId);
        }
      }
    } finally {
      videoQueueActive = false;
      if (videoRunQueue.length) startVideoQueueProcessor();
    }
  }, 0);
}

export async function queueVideoJob(jobId, input = {}) {
  const current = await readSelfModuleState("video");
  const job = current.items.find((item) => item.id === jobId);
  if (!job) {
    const error = new Error("video job not found");
    error.status = 404;
    throw error;
  }
  const worker = await getVideoWorkerStatus();
  const runId = idFor("videorun");
  const queuedAt = now();
  const operation = cleanVideoOperation(input.operation || job.lastOperation || "handoff");
  const dryRun = input.dryRun !== false;
  const run = queuedVideoRun({ runId, jobId, operation, dryRun, queuedAt, worker });
  const nextJob = {
    ...job,
    status: "queued",
    lastOperation: operation,
    lastRunId: runId,
    lastRunAt: queuedAt,
    videoHistory: [run, ...(Array.isArray(job.videoHistory) ? job.videoHistory : [])].slice(0, MAX_VIDEO_HISTORY),
    updatedAt: queuedAt
  };
  const nextState = {
    ...current,
    items: current.items.map((item) => item.id === jobId ? nextJob : item),
    updatedAt: queuedAt
  };
  await writeJson(await fileFor("video"), nextState);
  videoRunQueue.push({
    jobId,
    runId,
    runtimeHome: osRoot(),
    input: {
      ...input,
      operation,
      dryRun,
      queuedAt
    }
  });
  startVideoQueueProcessor();
  await appendModuleLog("video", {
    level: "info",
    message: "Video run queued",
    details: {
      jobId,
      runId,
      operation,
      dryRun
    }
  });
  return {
    ok: true,
    queued: true,
    mode: "queued",
    job: publicSelfValue(nextJob),
    run: publicSelfValue(run),
    worker,
    state: normalizeState("video", nextState)
  };
}

export async function cancelVideoRun(runId) {
  const queuedBefore = videoRunQueue.length;
  videoRunQueue = videoRunQueue.filter((item) => item.runId !== runId);
  const wasQueued = videoRunQueue.length !== queuedBefore;
  const controller = videoRunControllers.get(runId);
  if (controller) controller.abort();
  const result = await updateVideoRunRecord(runId, (run) => {
    if (VIDEO_TERMINAL_STATUSES.has(run.status)) return run;
    const canceled = wasQueued && !controller;
    return {
      ...run,
      status: canceled ? "canceled" : "cancel_requested",
      cancelRequested: true,
      completedAt: canceled ? now() : run.completedAt,
      progress: canceled ? 100 : videoRunProgress("cancel_requested"),
      progressDetails: progressDetails({
        stage: canceled ? "canceled" : "cancel_requested",
        currentCommand: run.progressDetails?.currentCommand || null,
        commandProgress: run.progressDetails?.commandProgress ?? null,
        samples: run.progressDetails?.samples || []
      }),
      message: canceled ? "Queued video run canceled before start." : "Cancellation requested for running video command."
    };
  });
  await appendModuleLog("video", {
    level: "warn",
    message: "Video run cancellation requested",
    details: { runId, wasQueued, running: Boolean(controller) }
  });
  return result;
}

export async function resolveVideoRunOutput(runId, fileName) {
  const safeName = path.basename(String(fileName || ""));
  if (!safeName) {
    const error = new Error("video output file not found");
    error.status = 404;
    throw error;
  }
  const { run } = await getVideoRun(runId);
  const allowed = [run.output?.manifest, run.output?.captions, run.output?.renderedVideo]
    .filter(Boolean)
    .map((item) => path.basename(String(item)));
  if (!allowed.includes(safeName)) {
    const error = new Error("video output file is not available for this run");
    error.status = 404;
    throw error;
  }
  const filePath = path.join(runtimePaths().runs, "video", runId, safeName);
  if (!await fileExists(filePath)) {
    const error = new Error("video output file not found");
    error.status = 404;
    throw error;
  }
  const ext = path.extname(safeName).toLowerCase();
  return {
    filePath,
    downloadName: safeName,
    contentType: ext === ".mp4" ? "video/mp4" : ext === ".srt" ? "application/x-subrip" : "application/json"
  };
}

export async function runVideoJob(jobId, input = {}) {
  const current = await readSelfModuleState("video");
  const job = current.items.find((item) => item.id === jobId);
  if (!job) {
    const error = new Error("video job not found");
    error.status = 404;
    throw error;
  }

  const runId = cleanOptionalText(input.runId) || idFor("videorun");
  const startedAt = now();
  const worker = await getVideoWorkerStatus();
  const sourcePath = cleanOptionalText(input.sourcePath || job.sourcePath);
  const expandedSourcePath = expandHome(sourcePath);
  const sourceExists = Boolean(expandedSourcePath && await fileExists(expandedSourcePath));
  const execEnabled = await isExecutionEnabled();
  const explicitExecution = input.dryRun === false;
  const mode = execEnabled && explicitExecution ? "executed" : "dry_run";
  const operation = cleanVideoOperation(input.operation || job.lastOperation || "handoff");
  let probeResult = { ok: false, status: "ready_to_configure", message: "", probe: null };
  const commandProgressSamples = [];
  async function updateCommandProgress(sample, samples = commandProgressSamples) {
    commandProgressSamples.length = 0;
    commandProgressSamples.push(...samples.slice(-20));
    if (!input.runId) return;
    const progress = sample?.runProgress ?? videoRunProgress("running");
    await updateVideoRunRecord(runId, (run) => ({
      ...run,
      status: run.status === "cancel_requested" ? run.status : "running",
      progress,
      progressDetails: progressDetails({
        stage: sample?.source === "completed" ? "command_completed" : "running",
        currentCommand: sample?.command || run.progressDetails?.currentCommand || null,
        commandProgress: sample?.percent ?? run.progressDetails?.commandProgress ?? null,
        samples
      }),
      message: sample?.command ? `${sample.command} progress ${Math.round(progress)}%.` : run.message
    }));
  }

  if (!sourcePath) {
    probeResult.message = "Video job needs sourcePath before worker inspection.";
  } else if (!worker.tools.ffprobe.available) {
    probeResult.message = "Install ffprobe or set HERMES_FFPROBE_PATH before worker inspection.";
  } else if (!sourceExists) {
    probeResult.message = "Video source file is not reachable from this runtime.";
  } else {
    const ffprobeCommand = process.env.HERMES_FFPROBE_PATH || await which("ffprobe");
    probeResult = await probeVideoSource(expandedSourcePath, ffprobeCommand);
  }

  const probe = probeResult.probe || null;
  const plans = probe ? buildVideoPlans(job, probe, worker, input) : buildVideoPlans(job, {}, worker, input);
  const runDir = path.join(runtimePaths().runs, "video", runId);
  const publicRunDir = publicVideoRunPath(runId);
  const executionMissing = videoExecutionMissing(operation, plans);
  let execution = {
    ok: false,
    status: videoRunStatus({ sourcePath, sourceExists, worker, probeResult, mode }),
    message: "",
    captionFile: null,
    renderedFile: null,
    commands: []
  };

  if (mode === "executed" && probeResult.ok && executionMissing.length) {
    execution = {
      ...execution,
      status: "ready_to_configure",
      message: `Video ${operation} needs ${executionMissing.join(", ")}.`
    };
  } else if (mode === "executed" && probeResult.ok && !executionMissing.length) {
    execution = await executeVideoOperations({
      operation,
      runId,
      runDir,
      job,
      sourcePath,
      expandedSourcePath,
      plans,
      probe,
      signal: input.signal,
      onProgress: updateCommandProgress
    });
  }

  const runStatus = execution.status;
  const completedAt = now();
  const publicCaptionOutput = execution.captionFile ? publicVideoRunPath(runId, path.basename(execution.captionFile)) : null;
  const publicRenderedOutput = execution.renderedFile ? publicVideoRunPath(runId, path.basename(execution.renderedFile)) : null;
  const manifestPath = mode === "executed" && ["completed", "error"].includes(runStatus) ? publicVideoRunPath(runId, "handoff.json") : null;
  const run = {
    id: runId,
    jobId,
    status: runStatus,
    mode,
    operation,
    dryRun: mode !== "executed",
    queuedAt: input.queuedAt || null,
    startedAt,
    completedAt,
    progress: videoRunProgress(runStatus),
    progressDetails: progressDetails({
      stage: VIDEO_TERMINAL_STATUSES.has(runStatus) ? runStatus : mode,
      currentCommand: null,
      commandProgress: null,
      samples: commandProgressSamples
    }),
    cancelRequested: Boolean(input.signal?.aborted),
    source: {
      path: publicSourceLabel(sourcePath),
      exists: sourceExists
    },
    probeStatus: probeResult.status,
    message: probeResult.message || execution.message || (runStatus === "completed" ? "Video worker execution completed." : "Video worker handoff planned."),
    probe,
    captionPlan: plans.captionPlan,
    renderPlan: plans.renderPlan,
    output: {
      directory: publicRunDir,
      manifest: manifestPath,
      captions: publicCaptionOutput,
      renderedVideo: publicRenderedOutput
    },
    commands: execution.commands,
    worker: {
      status: worker.status,
      missing: worker.missing,
      tools: worker.tools
    }
  };

  if (manifestPath) {
    await writeJson(path.join(runDir, "handoff.json"), {
      schemaVersion: 1,
      runId,
      jobId,
      createdAt: completedAt,
      operation,
      sourcePath: expandedSourcePath,
      publicSourcePath: publicSourceLabel(sourcePath),
      probe,
      captionPlan: plans.captionPlan,
      renderPlan: plans.renderPlan,
      outputs: {
        captions: execution.captionFile,
        renderedVideo: execution.renderedFile
      },
      progressDetails: run.progressDetails,
      commands: execution.commands
    });
  }

  const existingHistory = Array.isArray(job.videoHistory) ? job.videoHistory.filter((entry) => entry.id !== runId) : [];
  const nextJob = {
    ...job,
    status: runStatus,
    lastOperation: operation,
    renderPreset: plans.renderPlan.preset || job.renderPreset || "copy",
    workerRunCount: Number(job.workerRunCount || 0) + 1,
    lastRunAt: completedAt,
    lastRunId: runId,
    captionOutput: publicCaptionOutput || job.captionOutput || "",
    renderedOutput: publicRenderedOutput || job.renderedOutput || "",
    durationSeconds: probe?.durationSeconds ?? job.durationSeconds ?? null,
    hasAudio: probe ? probe.hasAudio : job.hasAudio ?? null,
    hasVideo: probe ? probe.hasVideo : job.hasVideo ?? null,
    width: probe?.width ?? job.width ?? null,
    height: probe?.height ?? job.height ?? null,
    frameRate: probe?.frameRate || job.frameRate || "",
    probe,
    captionPlan: plans.captionPlan,
    renderPlan: plans.renderPlan,
    videoHistory: [run, ...existingHistory].slice(0, MAX_VIDEO_HISTORY),
    updatedAt: completedAt
  };
  const items = current.items.map((item) => item.id === jobId ? nextJob : item);
  const nextState = {
    ...current,
    items,
    updatedAt: completedAt
  };
  const file = await fileFor("video");
  await writeJson(file, nextState);
  await appendModuleLog("video", {
    level: runStatus === "error" ? "error" : runStatus === "ready_to_configure" ? "warn" : "info",
    message: runStatus === "ready_to_configure" ? "Video worker needs setup" : "Video worker run recorded",
    details: {
      jobId,
      runId,
      status: runStatus,
      mode,
      sourceProvided: Boolean(sourcePath),
      sourceExists,
      probeStatus: probeResult.status,
      hasAudio: probe?.hasAudio ?? null,
      hasVideo: probe?.hasVideo ?? null,
      durationSeconds: probe?.durationSeconds ?? null
    }
  });

  return {
    ok: runStatus === "planned" || runStatus === "completed",
    mode,
    job: publicSelfValue(nextJob),
    run: publicSelfValue(run),
    worker,
    state: normalizeState("video", nextState)
  };
}

function parseGoalPlan(text, mode) {
  const raw = String(text || "").trim();
  if (!raw) {
    return {
      plan: [],
      nextAction: mode === "ready_to_configure" ? "Configure a Provider Router backend before running this goal loop." : "",
      rationale: "",
      risks: []
    };
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const plan = Array.isArray(parsed.plan)
        ? parsed.plan.map((item) => cleanText(item)).filter(Boolean).slice(0, 8)
        : [];
      const risks = Array.isArray(parsed.risks)
        ? parsed.risks.map((item) => cleanText(item)).filter(Boolean).slice(0, 6)
        : [];
      return {
        status: cleanText(parsed.status),
        plan,
        nextAction: cleanText(parsed.nextAction || parsed.next_action),
        rationale: cleanText(parsed.rationale || parsed.summary),
        risks
      };
    } catch {
      // Fall through to text parsing.
    }
  }

  if (mode === "dry_run") {
    return {
      plan: ["Router dry-run recorded the planned provider dispatch."],
      nextAction: "Enable trusted execution and pass dryRun:false to generate a provider-authored goal plan.",
      rationale: raw.slice(0, 500),
      risks: []
    };
  }

  if (mode === "ready_to_configure") {
    return {
      plan: [],
      nextAction: "Configure Ollama, OpenRouter, MiniMax, OpenAI, Anthropic, or Gemini in Provider Router.",
      rationale: raw.slice(0, 500),
      risks: ["No configured provider is available yet."]
    };
  }

  const lines = raw.split(/\r?\n/).map((line) => line.replace(/^[-*\d.\s]+/, "").trim()).filter(Boolean);
  return {
    plan: lines.slice(0, 6),
    nextAction: lines[0] || "Review the provider response and choose the next action.",
    rationale: raw.slice(0, 800),
    risks: []
  };
}

function buildGoalPrompt(goal, input = {}) {
  const recentHistory = Array.isArray(goal.history) ? goal.history.slice(0, 5) : [];
  return [
    "You are Hermes Agent OS goal planner.",
    "Return concise JSON only with keys: status, plan, nextAction, rationale, risks.",
    "Plan must be concrete, local-first, and safe. Do not claim work is done unless evidence is present.",
    `Goal title: ${goal.title}`,
    `Goal status: ${goal.status || "open"}`,
    `Goal notes: ${goal.notes || "none"}`,
    goal.plan?.length ? `Current plan: ${goal.plan.join(" | ")}` : "",
    goal.nextAction ? `Current next action: ${goal.nextAction}` : "",
    input.context ? `Additional context: ${String(input.context).slice(0, 2000)}` : "",
    recentHistory.length
      ? `Recent loop history: ${recentHistory.map((run) => `${run.status}:${run.nextAction || run.summary || ""}`).join(" | ")}`
      : ""
  ].filter(Boolean).join("\n");
}

function publicRouterResult(result) {
  return {
    ok: Boolean(result?.ok),
    mode: result?.mode || "unknown",
    provider: result?.provider || null,
    model: result?.model || null,
    status: result?.status || null,
    message: result?.message || "",
    plannedRequest: result?.plannedRequest || null,
    usage: result?.usage || null
  };
}

function cleanUrl(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  try {
    return new URL(raw).toString();
  } catch {
    const error = new Error("SEO brief needs a valid URL.");
    error.status = 400;
    throw error;
  }
}

function firecrawlScrapeUrl(stored) {
  return getConfiguredValue(stored, "provider-firecrawl", "HERMES_FIRECRAWL_SCRAPE_URL") ||
    getConfiguredValue(stored, "firecrawl-builder", "HERMES_FIRECRAWL_SCRAPE_URL") ||
    "https://api.firecrawl.dev/v2/scrape";
}

function firecrawlSearchUrl(stored) {
  return getConfiguredValue(stored, "provider-firecrawl", "HERMES_FIRECRAWL_SEARCH_URL") ||
    getConfiguredValue(stored, "firecrawl-builder", "HERMES_FIRECRAWL_SEARCH_URL") ||
    "https://api.firecrawl.dev/v2/search";
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      status: response.status,
      body,
      latencyMs: Date.now() - started
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: {},
      latencyMs: Date.now() - started,
      error: error?.name === "AbortError" ? "Firecrawl scrape timed out" : error?.message || "Firecrawl scrape failed"
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizedDomain(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  try {
    const parsed = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    return parsed.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return raw.replace(/^https?:\/\//i, "").split("/")[0].replace(/^www\./i, "").toLowerCase();
  }
}

function searchKeyword(brief, input = {}) {
  return cleanText(input.query || input.keyword || brief.keyword || brief.title);
}

function searchLimit(input = {}, fallback = 10) {
  const value = Number(input.limit || fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeDomainList(value) {
  return toArray(value)
    .map((item) => normalizedDomain(item))
    .filter(Boolean);
}

function searchResponseRows(response) {
  const data = response?.body?.data;
  const rawRows = Array.isArray(data)
    ? data
    : Array.isArray(data?.web)
      ? data.web
      : Array.isArray(response?.body?.web)
        ? response.body.web
        : [];
  return rawRows.map((row, index) => {
    const url = cleanText(row.url || row.sourceURL || row.metadata?.url || row.metadata?.sourceURL);
    return {
      position: Number(row.position || index + 1),
      title: cleanText(row.title || row.metadata?.title),
      description: cleanText(row.description || row.snippet || row.metadata?.description),
      url,
      domain: normalizedDomain(url),
      category: cleanText(row.category || "web"),
      markdownChars: cleanText(row.markdown || row.content).length
    };
  }).filter((row) => row.url);
}

function mergeCompetitors(existing = [], incoming = [], limit = MAX_SEO_COMPETITORS) {
  const seen = new Set();
  const merged = [];
  for (const row of [...incoming, ...existing]) {
    const url = cleanText(row.url);
    const domain = normalizedDomain(row.domain || url);
    const key = domain || url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push({
      title: cleanText(row.title || domain || "Competitor"),
      url,
      domain,
      description: cleanText(row.description),
      position: Number(row.position || merged.length + 1),
      discoveredAt: row.discoveredAt || now()
    });
    if (merged.length >= limit) break;
  }
  return merged;
}

async function recordSeoSearchUsage({ requestId, operation, mode, query, limit, creditsUsed }) {
  try {
    await createSelfModuleItem("usage-credits", {
      title: `Firecrawl ${operation} ${mode}`,
      provider: "firecrawl",
      operation,
      units: Number(creditsUsed || limit || 1),
      estimatedCost: 0,
      status: mode === "executed" ? "executed" : mode,
      mode: mode === "executed" ? "executed" : "dry_run",
      dryRun: mode !== "executed",
      source: "seo",
      requestId,
      notes: `Search query: ${String(query || "").slice(0, 120)}`
    });
  } catch (error) {
    await appendModuleLog("seo", {
      level: "warn",
      message: "SEO Firecrawl usage event was not recorded",
      details: { operation, reason: error?.message || "unknown" }
    });
  }
}

async function searchSeoWeb(brief, input = {}) {
  const query = searchKeyword(brief, input);
  if (!query) {
    const error = new Error("SEO search needs a keyword or query.");
    error.status = 400;
    throw error;
  }
  const stored = await getStoredConnectionConfig();
  const apiKey = getConfiguredValue(stored, "provider-firecrawl", "FIRECRAWL_API_KEY") ||
    getConfiguredValue(stored, "firecrawl-builder", "FIRECRAWL_API_KEY");
  const execEnabled = await isExecutionEnabled();
  const explicitExecution = input.dryRun === false;
  const endpoint = firecrawlSearchUrl(stored);
  const limit = searchLimit(input);
  const ownDomain = normalizedDomain(input.url || brief.url);
  const excludeDomains = [
    ...normalizeDomainList(input.excludeDomains),
    ...(input.excludeOwnDomain && ownDomain ? [ownDomain] : [])
  ].filter(Boolean);
  const includeDomains = normalizeDomainList(input.includeDomains);
  const requestBody = {
    query,
    limit,
    sources: ["web"],
    country: cleanText(input.country, "US"),
    timeout: Number(input.timeoutMs || 60000),
    ignoreInvalidURLs: true
  };
  if (cleanText(input.location)) requestBody.location = cleanText(input.location);
  if (cleanText(input.tbs)) requestBody.tbs = cleanText(input.tbs);
  if (includeDomains.length) requestBody.includeDomains = includeDomains;
  if (!includeDomains.length && excludeDomains.length) requestBody.excludeDomains = [...new Set(excludeDomains)];
  if (input.includeMarkdown) requestBody.scrapeOptions = { formats: [{ type: "markdown" }] };

  if (!apiKey) {
    return {
      ok: false,
      status: "ready_to_configure",
      mode: "ready_to_configure",
      endpoint,
      query,
      limit,
      missing: ["FIRECRAWL_API_KEY"],
      message: "Configure FIRECRAWL_API_KEY before running live SEO search.",
      request: requestBody,
      results: []
    };
  }

  if (!execEnabled || !explicitExecution) {
    return {
      ok: true,
      status: "planned",
      mode: "dry_run",
      endpoint,
      query,
      limit,
      missing: [],
      message: "Firecrawl would search the web. Set HERMES_AGENT_OS_ENABLE_EXEC=1 and pass dryRun:false to execute.",
      request: requestBody,
      results: []
    };
  }

  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestBody)
  }, Number(input.timeoutMs || 60000));
  const results = searchResponseRows(response);
  return {
    ok: response.ok,
    status: response.ok ? "completed" : "error",
    mode: "executed",
    endpoint,
    query,
    limit,
    missing: [],
    httpStatus: response.status,
    latencyMs: response.latencyMs,
    creditsUsed: Number(response.body?.creditsUsed || 0),
    firecrawlId: cleanText(response.body?.id),
    warning: cleanText(response.body?.warning),
    message: response.ok ? "Firecrawl search completed." : response.error || response.body?.error || "Firecrawl search failed.",
    request: requestBody,
    results
  };
}

function extractFirecrawlPage(result) {
  const data = result?.body?.data || result?.body || {};
  const markdown = cleanText(data.markdown || data.content || data.text).slice(0, 10000);
  const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  return {
    markdown,
    title: cleanText(metadata.title || data.title),
    description: cleanText(metadata.description || data.description),
    statusCode: metadata.statusCode || data.statusCode || result.status || null,
    sourceUrl: cleanText(metadata.sourceURL || metadata.sourceUrl || data.url)
  };
}

async function scrapeSeoPage(brief, input = {}) {
  const url = cleanUrl(input.url || brief.url);
  const stored = await getStoredConnectionConfig();
  const apiKey = getConfiguredValue(stored, "provider-firecrawl", "FIRECRAWL_API_KEY") ||
    getConfiguredValue(stored, "firecrawl-builder", "FIRECRAWL_API_KEY");
  const execEnabled = await isExecutionEnabled();
  const explicitExecution = input.dryRun === false;
  const endpoint = firecrawlScrapeUrl(stored);

  if (!apiKey) {
    return {
      ok: false,
      status: "ready_to_configure",
      mode: "ready_to_configure",
      url,
      endpoint,
      missing: ["FIRECRAWL_API_KEY"],
      message: "Configure FIRECRAWL_API_KEY before running a live SEO scrape.",
      page: null
    };
  }

  if (!execEnabled || !explicitExecution) {
    return {
      ok: true,
      status: "planned",
      mode: "dry_run",
      url,
      endpoint,
      missing: [],
      message: "Firecrawl would scrape this URL. Set HERMES_AGENT_OS_ENABLE_EXEC=1 and pass dryRun:false to execute.",
      page: null
    };
  }

  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
      onlyMainContent: true
    })
  }, Number(input.timeoutMs || 20000));
  const page = extractFirecrawlPage(response);
  return {
    ok: response.ok,
    status: response.ok ? "completed" : "error",
    mode: "executed",
    url,
    endpoint,
    missing: [],
    httpStatus: response.status,
    latencyMs: response.latencyMs,
    message: response.ok ? "Firecrawl scrape completed." : response.error || "Firecrawl scrape failed.",
    page
  };
}

function parseSeoAnalysis(text, mode) {
  const raw = String(text || "").trim();
  if (!raw) {
    return {
      score: null,
      recommendations: [],
      summary: mode === "ready_to_configure" ? "Configure a Provider Router backend before generating SEO recommendations." : "",
      risks: []
    };
  }
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const recommendations = Array.isArray(parsed.recommendations)
        ? parsed.recommendations.map((item) => cleanText(item)).filter(Boolean).slice(0, 8)
        : [];
      const risks = Array.isArray(parsed.risks)
        ? parsed.risks.map((item) => cleanText(item)).filter(Boolean).slice(0, 6)
        : [];
      return {
        score: parsed.score == null ? null : Number(parsed.score),
        recommendations,
        summary: cleanText(parsed.summary || parsed.rationale || parsed.brief),
        risks
      };
    } catch {
      // Fall through to text parsing.
    }
  }
  if (mode === "dry_run") {
    return {
      score: null,
      recommendations: ["Router dry-run recorded the planned SEO analysis request."],
      summary: raw.slice(0, 800),
      risks: []
    };
  }
  if (mode === "ready_to_configure") {
    return {
      score: null,
      recommendations: ["Configure Ollama, OpenRouter, MiniMax, OpenAI, Anthropic, or Gemini for SEO analysis."],
      summary: raw.slice(0, 800),
      risks: ["No configured model provider is available yet."]
    };
  }
  const lines = raw.split(/\r?\n/).map((line) => line.replace(/^[-*\d.\s]+/, "").trim()).filter(Boolean);
  return {
    score: null,
    recommendations: lines.slice(0, 8),
    summary: raw.slice(0, 1000),
    risks: []
  };
}

function buildSeoPrompt(brief, scrape, input = {}) {
  const page = scrape.page || {};
  return [
    "You are Hermes Agent OS SEO analyst.",
    "Return concise JSON only with keys: score, summary, recommendations, risks.",
    "Use only the provided page evidence. Do not claim a crawl or ranking check happened unless evidence exists.",
    `URL: ${scrape.url || brief.url}`,
    `Target keyword: ${brief.keyword || input.keyword || "not provided"}`,
    `Brief title: ${brief.title}`,
    `Brief notes: ${brief.notes || "none"}`,
    input.context ? `Additional context: ${String(input.context).slice(0, 2000)}` : "",
    page.title ? `Page title: ${page.title}` : "",
    page.description ? `Meta description: ${page.description}` : "",
    page.markdown ? `Page markdown excerpt:\n${page.markdown.slice(0, 6000)}` : `Scrape state: ${scrape.status}. ${scrape.message || ""}`
  ].filter(Boolean).join("\n");
}

export async function runSeoAudit(briefId, input = {}) {
  const current = await readSelfModuleState("seo");
  const brief = current.items.find((item) => item.id === briefId);
  if (!brief) {
    const error = new Error("SEO brief not found");
    error.status = 404;
    throw error;
  }

  const runId = idFor("seorun");
  const startedAt = now();
  const scrape = await scrapeSeoPage(brief, input);
  const router = await runRouter({
    provider: input.provider,
    prompt: buildSeoPrompt(brief, scrape, input),
    dryRun: input.dryRun !== false,
    requestId: input.requestId || runId,
    operation: "seo_audit",
    source: "seo"
  });
  const completedAt = now();
  const analysis = parseSeoAnalysis(router.message, router.mode);
  const runStatus = scrape.status === "error"
    ? "error"
    : router.ok
      ? router.mode === "executed" ? "completed" : "planned"
      : scrape.status === "ready_to_configure" || router.mode === "ready_to_configure" ? "ready_to_configure" : "error";
  const run = {
    id: runId,
    briefId,
    status: runStatus,
    mode: router.mode === "executed" || scrape.mode === "executed" ? "executed" : router.mode,
    provider: router.provider || input.provider || null,
    model: router.model || null,
    dryRun: router.mode !== "executed" || scrape.mode !== "executed",
    startedAt,
    completedAt,
    url: scrape.url,
    keyword: brief.keyword || "",
    scrape: {
      status: scrape.status,
      mode: scrape.mode,
      endpoint: scrape.endpoint,
      httpStatus: scrape.httpStatus || null,
      latencyMs: scrape.latencyMs || 0,
      missing: scrape.missing || [],
      message: scrape.message,
      page: scrape.page ? {
        title: scrape.page.title,
        description: scrape.page.description,
        statusCode: scrape.page.statusCode,
        sourceUrl: scrape.page.sourceUrl,
        markdownChars: scrape.page.markdown?.length || 0
      } : null
    },
    score: analysis.score,
    summary: analysis.summary,
    recommendations: analysis.recommendations,
    risks: analysis.risks,
    usage: router.usage || null
  };

  const nextBrief = {
    ...brief,
    status: runStatus === "completed" || runStatus === "planned" ? "audited" : brief.status,
    auditCount: Number(brief.auditCount || 0) + 1,
    lastAuditAt: completedAt,
    lastAuditId: runId,
    scrapeStatus: scrape.status,
    provider: router.provider || brief.provider || "",
    model: router.model || brief.model || "",
    score: analysis.score,
    recommendations: analysis.recommendations,
    seoHistory: [run, ...(Array.isArray(brief.seoHistory) ? brief.seoHistory : [])].slice(0, MAX_SEO_HISTORY),
    updatedAt: completedAt
  };
  const items = current.items.map((item) => item.id === briefId ? nextBrief : item);
  const nextState = {
    ...current,
    items,
    updatedAt: completedAt
  };
  const file = await fileFor("seo");
  await writeJson(file, nextState);
  await appendModuleLog("seo", {
    level: runStatus === "error" ? "error" : runStatus === "ready_to_configure" ? "warn" : "info",
    message: runStatus === "ready_to_configure" ? "SEO audit needs provider configuration" : "SEO audit run recorded",
    details: {
      briefId,
      runId,
      status: runStatus,
      mode: run.mode,
      url: scrape.url,
      keyword: brief.keyword,
      scrapeStatus: scrape.status,
      provider: router.provider || input.provider || "",
      model: router.model || "",
      recommendations: analysis.recommendations.length
    }
  });

  return {
    ok: runStatus === "completed" || runStatus === "planned",
    mode: run.mode,
    brief: publicSelfValue(nextBrief),
    run: publicSelfValue(run),
    router: publicRouterResult(router),
    state: normalizeState("seo", nextState)
  };
}

export async function runSeoDiscovery(briefId, input = {}) {
  const current = await readSelfModuleState("seo");
  const brief = current.items.find((item) => item.id === briefId);
  if (!brief) {
    const error = new Error("SEO brief not found");
    error.status = 404;
    throw error;
  }

  const runId = idFor("seodiscovery");
  const startedAt = now();
  const search = await searchSeoWeb(brief, {
    ...input,
    excludeOwnDomain: input.excludeOwnDomain !== false,
    limit: input.limit || 10
  });
  const completedAt = now();
  const ownDomain = normalizedDomain(input.url || brief.url);
  const competitors = search.results
    .filter((row) => row.domain && row.domain !== ownDomain)
    .slice(0, MAX_SEO_COMPETITORS)
    .map((row) => ({
      title: row.title || row.domain,
      url: row.url,
      domain: row.domain,
      description: row.description,
      position: row.position,
      discoveredAt: completedAt
    }));
  const runStatus = search.status;
  const run = {
    id: runId,
    briefId,
    type: "competitor_discovery",
    status: runStatus,
    mode: search.mode,
    dryRun: search.mode !== "executed",
    startedAt,
    completedAt,
    query: search.query,
    keyword: brief.keyword || input.keyword || "",
    endpoint: search.endpoint,
    httpStatus: search.httpStatus || null,
    latencyMs: search.latencyMs || 0,
    missing: search.missing || [],
    message: search.message,
    warning: search.warning || "",
    firecrawlId: search.firecrawlId || "",
    creditsUsed: search.creditsUsed || 0,
    plannedRequest: search.mode === "dry_run" ? search.request : null,
    resultCount: search.results.length,
    results: search.results,
    competitors
  };
  await recordSeoSearchUsage({
    requestId: runId,
    operation: "seo_competitor_discovery",
    mode: search.mode === "executed" ? "executed" : "dry_run",
    query: search.query,
    limit: search.limit,
    creditsUsed: search.creditsUsed
  });

  const nextBrief = {
    ...brief,
    status: runStatus === "completed" || runStatus === "planned" ? "researched" : brief.status,
    discoveryCount: Number(brief.discoveryCount || 0) + 1,
    lastDiscoveryAt: completedAt,
    lastDiscoveryId: runId,
    searchStatus: search.status,
    competitors: mergeCompetitors(brief.competitors, competitors),
    discoveryHistory: [run, ...(Array.isArray(brief.discoveryHistory) ? brief.discoveryHistory : [])].slice(0, MAX_SEO_SEARCH_HISTORY),
    updatedAt: completedAt
  };
  const items = current.items.map((item) => item.id === briefId ? nextBrief : item);
  const nextState = {
    ...current,
    items,
    updatedAt: completedAt
  };
  await writeJson(await fileFor("seo"), nextState);
  await appendModuleLog("seo", {
    level: runStatus === "error" ? "error" : runStatus === "ready_to_configure" ? "warn" : "info",
    message: runStatus === "ready_to_configure" ? "SEO discovery needs Firecrawl configuration" : "SEO competitor discovery recorded",
    details: {
      briefId,
      runId,
      status: runStatus,
      mode: run.mode,
      query: search.query,
      resultCount: search.results.length,
      competitors: competitors.length
    }
  });

  return {
    ok: runStatus === "completed" || runStatus === "planned",
    mode: run.mode,
    brief: publicSelfValue(nextBrief),
    run: publicSelfValue(run),
    state: normalizeState("seo", nextState)
  };
}

export async function runSeoRankSnapshot(briefId, input = {}) {
  const current = await readSelfModuleState("seo");
  const brief = current.items.find((item) => item.id === briefId);
  if (!brief) {
    const error = new Error("SEO brief not found");
    error.status = 404;
    throw error;
  }

  const runId = idFor("seorank");
  const startedAt = now();
  const search = await searchSeoWeb(brief, {
    ...input,
    excludeOwnDomain: false,
    limit: input.limit || 20
  });
  const completedAt = now();
  const ownDomain = normalizedDomain(input.url || brief.url);
  const knownCompetitors = new Set((Array.isArray(brief.competitors) ? brief.competitors : []).map((item) => normalizedDomain(item.domain || item.url)).filter(Boolean));
  const rows = search.results.map((row) => ({
    position: row.position,
    title: row.title,
    url: row.url,
    domain: row.domain,
    description: row.description,
    isTarget: Boolean(ownDomain && row.domain === ownDomain),
    isKnownCompetitor: knownCompetitors.has(row.domain)
  }));
  const target = rows.find((row) => row.isTarget) || null;
  const competitorRows = rows.filter((row) => row.isKnownCompetitor).slice(0, MAX_SEO_COMPETITORS);
  const snapshot = {
    id: runId,
    query: search.query,
    keyword: brief.keyword || input.keyword || "",
    capturedAt: completedAt,
    status: target ? "found" : search.status === "completed" ? "not_found" : search.status,
    targetDomain: ownDomain,
    targetPosition: target?.position || null,
    topResult: rows[0] || null,
    competitors: competitorRows,
    resultCount: rows.length
  };
  const runStatus = search.status;
  const run = {
    id: runId,
    briefId,
    type: "rank_snapshot",
    status: runStatus,
    mode: search.mode,
    dryRun: search.mode !== "executed",
    startedAt,
    completedAt,
    query: search.query,
    keyword: brief.keyword || input.keyword || "",
    endpoint: search.endpoint,
    httpStatus: search.httpStatus || null,
    latencyMs: search.latencyMs || 0,
    missing: search.missing || [],
    message: search.message,
    warning: search.warning || "",
    firecrawlId: search.firecrawlId || "",
    creditsUsed: search.creditsUsed || 0,
    plannedRequest: search.mode === "dry_run" ? search.request : null,
    snapshot,
    results: rows
  };
  await recordSeoSearchUsage({
    requestId: runId,
    operation: "seo_rank_snapshot",
    mode: search.mode === "executed" ? "executed" : "dry_run",
    query: search.query,
    limit: search.limit,
    creditsUsed: search.creditsUsed
  });

  const nextBrief = {
    ...brief,
    status: runStatus === "completed" || runStatus === "planned" ? "ranked" : brief.status,
    rankCount: Number(brief.rankCount || 0) + 1,
    lastRankAt: completedAt,
    lastRankId: runId,
    searchStatus: search.status,
    rankSnapshots: [snapshot, ...(Array.isArray(brief.rankSnapshots) ? brief.rankSnapshots : [])].slice(0, MAX_SEO_RANK_SNAPSHOTS),
    rankHistory: [run, ...(Array.isArray(brief.rankHistory) ? brief.rankHistory : [])].slice(0, MAX_SEO_SEARCH_HISTORY),
    updatedAt: completedAt
  };
  const items = current.items.map((item) => item.id === briefId ? nextBrief : item);
  const nextState = {
    ...current,
    items,
    updatedAt: completedAt
  };
  await writeJson(await fileFor("seo"), nextState);
  await appendModuleLog("seo", {
    level: runStatus === "error" ? "error" : runStatus === "ready_to_configure" ? "warn" : "info",
    message: runStatus === "ready_to_configure" ? "SEO rank snapshot needs Firecrawl configuration" : "SEO rank snapshot recorded",
    details: {
      briefId,
      runId,
      status: runStatus,
      mode: run.mode,
      query: search.query,
      resultCount: rows.length,
      targetPosition: snapshot.targetPosition,
      snapshotStatus: snapshot.status
    }
  });

  return {
    ok: runStatus === "completed" || runStatus === "planned",
    mode: run.mode,
    brief: publicSelfValue(nextBrief),
    run: publicSelfValue(run),
    state: normalizeState("seo", nextState)
  };
}

export async function runGoalLoop(goalId, input = {}) {
  const current = await readSelfModuleState("goals");
  const goal = current.items.find((item) => item.id === goalId);
  if (!goal) {
    const error = new Error("goal not found");
    error.status = 404;
    throw error;
  }

  const runId = idFor("goalrun");
  const startedAt = now();
  const router = await runRouter({
    provider: input.provider,
    prompt: buildGoalPrompt(goal, input),
    dryRun: input.dryRun !== false,
    requestId: input.requestId || runId,
    operation: "goal_loop",
    source: "goals"
  });
  const completedAt = now();
  const parsed = parseGoalPlan(router.message, router.mode);
  const runStatus = router.ok
    ? router.mode === "executed" ? "completed" : "planned"
    : router.mode === "ready_to_configure" ? "ready_to_configure" : "error";
  const nextAction = parsed.nextAction || goal.nextAction || "";
  const plan = parsed.plan.length ? parsed.plan : Array.isArray(goal.plan) ? goal.plan : [];
  const run = {
    id: runId,
    goalId,
    status: runStatus,
    mode: router.mode,
    provider: router.provider || input.provider || null,
    model: router.model || null,
    dryRun: router.mode !== "executed",
    startedAt,
    completedAt,
    summary: parsed.rationale || router.message || "",
    plan,
    nextAction,
    risks: parsed.risks || [],
    usage: router.usage || null
  };

  const nextGoal = {
    ...goal,
    status: router.ok && String(goal.status || "open").toLowerCase() === "open" ? "in_progress" : goal.status,
    plan,
    nextAction,
    loopCount: Number(goal.loopCount || 0) + 1,
    lastRunAt: completedAt,
    lastRunId: runId,
    provider: router.provider || goal.provider || "",
    model: router.model || goal.model || "",
    history: [run, ...(Array.isArray(goal.history) ? goal.history : [])].slice(0, MAX_GOAL_HISTORY),
    updatedAt: completedAt
  };
  const items = current.items.map((item) => item.id === goalId ? nextGoal : item);
  const nextState = {
    ...current,
    items,
    updatedAt: completedAt
  };
  const file = await fileFor("goals");
  await writeJson(file, nextState);
  await appendModuleLog("goals", {
    level: router.ok ? "info" : "warn",
    message: router.ok ? "Goal loop run planned" : "Goal loop needs provider configuration",
    details: {
      goalId,
      runId,
      mode: router.mode,
      provider: router.provider || input.provider || "",
      model: router.model || "",
      status: runStatus,
      dryRun: run.dryRun,
      nextAction
    }
  });

  return {
    ok: router.ok,
    mode: router.mode,
    goal: publicSelfValue(nextGoal),
    run: publicSelfValue(run),
    router: publicRouterResult(router),
    state: normalizeState("goals", nextState)
  };
}
