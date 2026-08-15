import crypto from "node:crypto";
import path from "node:path";
import { appendModuleLog, readModuleLogs } from "./module-logs.js";
import { sanitizeObject } from "./safety.js";
import { ensureRuntimeStore, readJson, runtimePaths, writeJson } from "./store.js";

const SKILL_CATALOG = [
  {
    id: "local-ollama-coder",
    label: "Local Ollama Coder",
    version: "0.1.0",
    category: "code",
    description: "Claude Code-style local coding skill routed through a user-owned Ollama model.",
    requiredKeys: ["OLLAMA_HOST"],
    requiredAnyKeys: [],
    optionalKeys: ["HERMES_OLLAMA_MODEL"],
    capabilities: ["code", "local-models", "workspace-plans"],
    samplePrompt: "Plan a local code change and keep execution dry-run unless explicitly enabled.",
    releaseNotes: [
      {
        version: "0.1.0",
        title: "Initial local coding route",
        items: ["Adds a Claude Code-style local coding skill backed by user-owned Ollama configuration."]
      }
    ],
    exportSafe: true
  },
  {
    id: "seo-research-agent",
    label: "SEO Research Agent",
    version: "0.1.0",
    category: "seo",
    description: "Research keywords and page opportunities with Firecrawl plus a configured model provider.",
    requiredKeys: ["FIRECRAWL_API_KEY"],
    requiredAnyKeys: [["OPENROUTER_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "MINIMAX_API_KEY", "OLLAMA_HOST"]],
    optionalKeys: ["HERMES_OPENROUTER_MODEL", "HERMES_OPENAI_MODEL"],
    capabilities: ["crawl", "keyword-research", "content-briefs"],
    samplePrompt: "Crawl a site, extract topics, and produce an SEO brief with source URLs.",
    releaseNotes: [
      {
        version: "0.1.0",
        title: "Initial SEO research workflow",
        items: ["Connects Firecrawl and a configured model provider for export-safe SEO briefs."]
      }
    ],
    exportSafe: true
  },
  {
    id: "video-caption-agent",
    label: "Video Caption Agent",
    version: "0.1.0",
    category: "video",
    description: "Caption and summarize local videos through user-owned Whisper-compatible providers.",
    requiredKeys: [],
    requiredAnyKeys: [["GROQ_API_KEY", "OPENAI_API_KEY"]],
    optionalKeys: ["WHISPER_MODEL_SIZE"],
    capabilities: ["transcription", "captions", "summaries"],
    samplePrompt: "Transcribe this video and create native caption segments without covering the main subject.",
    releaseNotes: [
      {
        version: "0.1.0",
        title: "Initial caption workflow",
        items: ["Uses user-owned Whisper-compatible providers for native caption preparation."]
      }
    ],
    exportSafe: true
  },
  {
    id: "memory-curator",
    label: "Memory Curator",
    version: "0.1.0",
    category: "memory",
    description: "Review notes and workflow outcomes, then promote useful facts into semantic, episodic, or procedural memory.",
    requiredKeys: [],
    requiredAnyKeys: [],
    optionalKeys: [],
    capabilities: ["semantic-memory", "episodic-memory", "procedural-memory"],
    samplePrompt: "Extract durable facts, experiences, and reusable procedures from the latest run notes.",
    releaseNotes: [
      {
        version: "0.1.0",
        title: "Initial memory curation workflow",
        items: ["Adds a safe sample skill for promoting useful notes into local Agent OS memory."]
      }
    ],
    exportSafe: true
  }
];

const BUNDLE_KIND = "hermes.skill.bundle";
const BUNDLE_SCHEMA_VERSION = 1;
const FEED_KIND = "hermes.skill.feed";
const FEED_SCHEMA_VERSION = 1;
const ALLOWED_PERMISSIONS = new Set([
  "model",
  "memory",
  "workflow",
  "mcp",
  "network",
  "filesystem-read",
  "scheduler",
  "usage",
  "self-module"
]);

function now() {
  return new Date().toISOString();
}

function safeId(id) {
  return String(id || "").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
}

function skillLogId(id) {
  return `skill-${safeId(id)}`;
}

function skillConfigPath() {
  return path.join(runtimePaths().config, "skills.local.json");
}

function defaultMarketplace() {
  return {
    feeds: {},
    items: {},
    policy: {
      enforceAllowlist: false,
      allowedPublishers: {},
      blockedPublishers: {},
      updatedAt: null
    },
    updatedAt: null
  };
}

function builtinById(id) {
  return SKILL_CATALOG.find((skill) => skill.id === id) || null;
}

function catalogById(id, state = null) {
  const clean = safeId(id);
  return builtinById(clean) || state?.external?.[clean]?.manifest || null;
}

function allCatalogSkills(state) {
  return [
    ...SKILL_CATALOG,
    ...Object.values(state.external || {}).map((entry) => entry.manifest)
  ];
}

async function readState() {
  await ensureRuntimeStore();
  const state = await readJson(skillConfigPath(), {});
  return {
    schemaVersion: 6,
    installed: state?.installed || {},
    external: state?.external || {},
    marketplace: {
      ...defaultMarketplace(),
      ...(state?.marketplace || {}),
      feeds: state?.marketplace?.feeds || {},
      items: state?.marketplace?.items || {},
      policy: {
        ...defaultMarketplace().policy,
        ...(state?.marketplace?.policy || {}),
        allowedPublishers: state?.marketplace?.policy?.allowedPublishers || {},
        blockedPublishers: state?.marketplace?.policy?.blockedPublishers || {}
      }
    },
    publishers: state?.publishers || {},
    trustedPublishers: state?.trustedPublishers || {},
    updatedAt: state?.updatedAt || null
  };
}

async function writeState(state) {
  await ensureRuntimeStore();
  const next = {
    schemaVersion: 6,
    installed: state.installed || {},
    external: state.external || {},
    marketplace: {
      ...defaultMarketplace(),
      ...(state.marketplace || {}),
      feeds: state.marketplace?.feeds || {},
      items: state.marketplace?.items || {},
      policy: {
        ...defaultMarketplace().policy,
        ...(state.marketplace?.policy || {}),
        allowedPublishers: state.marketplace?.policy?.allowedPublishers || {},
        blockedPublishers: state.marketplace?.policy?.blockedPublishers || {}
      }
    },
    publishers: state.publishers || {},
    trustedPublishers: state.trustedPublishers || {},
    updatedAt: now()
  };
  await writeJson(skillConfigPath(), next);
  return next;
}

function cleanFields(fields = {}) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value != null && String(value).trim() !== "")
  );
}

function configuredValue(record, key) {
  return process.env[key] || record?.fields?.[key] || null;
}

function missingKeys(skill, record) {
  const missing = [];
  for (const key of skill.requiredKeys || []) {
    if (!configuredValue(record, key)) missing.push(key);
  }
  for (const group of skill.requiredAnyKeys || []) {
    if (!group.some((key) => configuredValue(record, key))) missing.push(group.join(" or "));
  }
  return missing;
}

function externalEntryFor(skill, state) {
  return state.external?.[skill.id] || null;
}

function skillStatus(skill, record, state = null) {
  if (!record) return "available";
  if (!record.enabled) return "disabled";
  const missing = missingKeys(skill, record);
  const blockedDependencies = state ? blockingDependencies(skill, state) : [];
  return missing.length || blockedDependencies.length ? "ready_to_configure" : "enabled";
}

function marketplaceItems(state) {
  return Object.values(state.marketplace.items || {})
    .flatMap((feed) => Array.isArray(feed.items) ? feed.items : []);
}

function marketplaceUpdateFor(state, skill) {
  if (!state || !skill?.id) return null;
  const currentVersion = state.external?.[skill.id]?.manifest?.version || skill.version;
  const candidates = marketplaceItems(state)
    .filter((item) => item.skillId === skill.id && compareVersions(item.version, currentVersion) > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0] || null;
}

function publicSkill(skill, record = null, state = null) {
  const external = state ? externalEntryFor(skill, state) : null;
  const missing = missingKeys(skill, record);
  const dependencyStatus = state ? dependencyStatusFor(skill, state) : [];
  const dependencySuggestions = state ? dependencySuggestionsFor(dependencyStatus, state) : [];
  const marketplaceUpdate = state ? marketplaceUpdateFor(state, skill) : null;
  const status = skillStatus(skill, record, state);
  const latestVersion = marketplaceUpdate?.version || skill.version;
  const updateAvailable = Boolean(record?.version && latestVersion && record.version !== latestVersion);
  const publisherFingerprint = external?.signature?.publicKeyFingerprint || null;
  const publisherTrusted = publisherFingerprint ? Boolean(state?.trustedPublishers?.[publisherFingerprint]) : skill.source !== "external";
  const publisherRecord = publisherFingerprint ? state?.publishers?.[publisherFingerprint] || {} : {};
  return {
    id: skill.id,
    label: skill.label,
    version: record?.version || skill.version,
    latestVersion,
    updateAvailable,
    updateChannel: skill.updateChannel || "stable",
    category: skill.category,
    description: skill.description,
    capabilities: skill.capabilities,
    permissions: skill.permissions || [],
    requiredKeys: skill.requiredKeys || [],
    requiredAnyKeys: skill.requiredAnyKeys || [],
    optionalKeys: skill.optionalKeys || [],
    dependencies: skill.dependencies || [],
    dependencyStatus,
    dependencySuggestions,
    dependencyReady: dependencyStatus.every((dependency) => dependency.optional || dependency.status === "satisfied"),
    availableUpdate: marketplaceUpdate ? {
      feedId: marketplaceUpdate.feedId,
      version: marketplaceUpdate.version,
      updateChannel: marketplaceUpdate.updateChannel || "stable",
      publisherFingerprint: marketplaceUpdate.publisherFingerprint,
      bundleHash: marketplaceUpdate.bundleHash,
      releaseNotes: cleanReleaseNotes(marketplaceUpdate.releaseNotes, marketplaceUpdate.version)
    } : null,
    installed: Boolean(record),
    enabled: Boolean(record?.enabled),
    status,
    configured: Boolean(record) && missing.length === 0,
    missing,
    configuredFields: Object.keys(record?.fields || {}),
    installedAt: record?.installedAt || null,
    updatedAt: record?.updatedAt || null,
    lastTestedAt: record?.lastTestedAt || null,
    samplePrompt: skill.samplePrompt,
    releaseNotes: cleanReleaseNotes(skill.releaseNotes, skill.version),
    exportSafe: Boolean(skill.exportSafe),
    source: skill.source || (external ? "external" : "built_in"),
    signatureVerified: Boolean(external?.signature?.verified),
    publisherFingerprint,
    publisherTrusted,
    publisherAllowed: publisherFingerprint && state ? publisherAllowed(state, publisherFingerprint) : !publisherFingerprint,
    publisherBlocked: publisherFingerprint && state ? publisherBlocked(state, publisherFingerprint) : false,
    publisherImportAllowed: publisherFingerprint && state ? publisherImportAllowed(state, publisherFingerprint) : true,
    publisherReputation: publisherFingerprint ? publicReputation(publisherRecord) : null,
    importedAt: external?.importedAt || null,
    actions: record
      ? ["configure", "test", record.enabled ? "disable" : "enable", "logs", "uninstall"]
      : ["install", "docs"]
  };
}

function cleanText(value, fallback = "", max = 500) {
  const text = String(value || "").trim();
  return (text || fallback).slice(0, max);
}

function cleanReleaseNotes(value, fallbackVersion = "0.1.0") {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((entry) => {
    const source = typeof entry === "string" ? { items: [entry] } : entry || {};
    const items = Array.isArray(source.items)
      ? source.items.map((item) => cleanText(item, "", 220)).filter(Boolean).slice(0, 12)
      : cleanText(source.body || source.note || source.description, "", 600)
        .split(/\n+/)
        .map((item) => cleanText(item, "", 220))
        .filter(Boolean)
        .slice(0, 12);
    return {
      version: cleanVersion(source.version || fallbackVersion),
      title: cleanText(source.title, "Release notes", 100),
      date: cleanText(source.date, "", 32) || null,
      channel: cleanUpdateChannel(source.channel || source.updateChannel || "stable"),
      breaking: Boolean(source.breaking),
      items
    };
  }).filter((entry) => entry.items.length);
}

function cleanFeedId(value) {
  return safeId(value || `feed-${Date.now()}`) || `feed-${Date.now()}`;
}

function cleanFingerprint(value) {
  const fingerprint = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : "";
}

function cleanReputationScore(value) {
  if (value == null || value === "") return null;
  const score = Number(value);
  if (!Number.isFinite(score)) return null;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function cleanReputationTier(value, score = null) {
  const tier = cleanText(value, "", 24).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (["verified", "trusted", "neutral", "caution", "blocked", "unknown"].includes(tier)) return tier;
  if (score == null) return "unknown";
  if (score >= 85) return "verified";
  if (score >= 65) return "trusted";
  if (score >= 40) return "neutral";
  return "caution";
}

function publisherPolicy(state) {
  return {
    ...defaultMarketplace().policy,
    ...(state.marketplace?.policy || {}),
    allowedPublishers: state.marketplace?.policy?.allowedPublishers || {},
    blockedPublishers: state.marketplace?.policy?.blockedPublishers || {}
  };
}

function publisherAllowed(state, fingerprint) {
  const clean = cleanFingerprint(fingerprint);
  return clean ? Boolean(publisherPolicy(state).allowedPublishers?.[clean]) : false;
}

function publisherBlocked(state, fingerprint) {
  const clean = cleanFingerprint(fingerprint);
  return clean ? Boolean(publisherPolicy(state).blockedPublishers?.[clean]) : false;
}

function publisherImportAllowed(state, fingerprint) {
  const policy = publisherPolicy(state);
  if (!fingerprint) return true;
  if (publisherBlocked(state, fingerprint)) return false;
  if (policy.enforceAllowlist && !publisherAllowed(state, fingerprint)) return false;
  return true;
}

function publicReputation(record = {}) {
  const reputation = record.reputation || {};
  const score = cleanReputationScore(reputation.score);
  return {
    score,
    tier: cleanReputationTier(reputation.tier, score),
    source: reputation.source || "manual",
    notes: reputation.notes || "",
    updatedAt: reputation.updatedAt || record.updatedAt || null
  };
}

function publicPublisherPolicy(state) {
  const policy = publisherPolicy(state);
  return {
    enforceAllowlist: Boolean(policy.enforceAllowlist),
    allowedCount: Object.keys(policy.allowedPublishers || {}).length,
    blockedCount: Object.keys(policy.blockedPublishers || {}).length,
    updatedAt: policy.updatedAt || null
  };
}

function validateFeedUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    const error = new Error("Marketplace feed URL must be a valid http(s) URL.");
    error.status = 400;
    throw error;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    const error = new Error("Marketplace feed URL must use http or https.");
    error.status = 400;
    throw error;
  }
  return parsed.toString();
}

function publicUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.search) parsed.search = "?redacted";
    if (parsed.username || parsed.password) {
      parsed.username = "redacted";
      parsed.password = "redacted";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function cleanVersion(value) {
  const version = cleanText(value, "0.1.0", 64);
  return version.replace(/[^a-z0-9.+_-]/gi, "") || "0.1.0";
}

function compareVersions(left, right) {
  const leftParts = String(left || "0").split(/[.+_-]/).map((part) => Number.parseInt(part, 10));
  const rightParts = String(right || "0").split(/[.+_-]/).map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = Number.isFinite(leftParts[index]) ? leftParts[index] : 0;
    const b = Number.isFinite(rightParts[index]) ? rightParts[index] : 0;
    if (a !== b) return a > b ? 1 : -1;
  }
  return String(left || "").localeCompare(String(right || ""));
}

function cleanUpdateChannel(value) {
  const channel = cleanText(value, "stable", 40).toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return channel || "stable";
}

function cleanKey(key) {
  const cleaned = String(key || "").trim().replace(/[^A-Z0-9_]/g, "");
  return /^[A-Z][A-Z0-9_]*$/.test(cleaned) ? cleaned : "";
}

function cleanKeyList(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(cleanKey).filter(Boolean))).slice(0, 30);
}

function cleanRequiredAny(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((group) => cleanKeyList(group).slice(0, 8))
    .filter((group) => group.length)
    .slice(0, 10);
}

function cleanWordList(value, allowed = null) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((item) => cleanText(item, "", 48).toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""))
    .filter((item) => item && (!allowed || allowed.has(item)))))
    .slice(0, 30);
}

function cleanDependencies(value, ownId = "") {
  if (!Array.isArray(value)) return [];
  const dependencies = [];
  const seen = new Set();
  for (const entry of value.slice(0, 30)) {
    const source = typeof entry === "string" ? { id: entry } : entry || {};
    const id = safeId(source.id || source.skillId);
    if (!id || id === ownId || seen.has(id)) continue;
    seen.add(id);
    dependencies.push({
      id,
      version: source.version == null || source.version === "" ? null : cleanVersion(source.version),
      optional: Boolean(source.optional),
      reason: cleanText(source.reason, "", 160)
    });
  }
  return dependencies;
}

function dependencyStatusFor(skill, state) {
  return (skill.dependencies || []).map((dependency) => {
    const record = state?.installed?.[dependency.id] || null;
    const manifest = catalogById(dependency.id, state);
    const installedVersion = record?.version || null;
    let status = "satisfied";
    if (!record) status = dependency.optional ? "optional_missing" : "missing";
    else if (!record.enabled) status = dependency.optional ? "optional_disabled" : "disabled";
    else if (dependency.version && compareVersions(installedVersion, dependency.version) < 0) status = "version_mismatch";
    return {
      id: dependency.id,
      version: dependency.version,
      optional: dependency.optional,
      reason: dependency.reason,
      label: manifest?.label || dependency.id,
      installed: Boolean(record),
      enabled: Boolean(record?.enabled),
      installedVersion,
      status
    };
  });
}

function blockingDependencies(skill, state) {
  return dependencyStatusFor(skill, state).filter((dependency) => !dependency.optional && ["missing", "disabled", "version_mismatch"].includes(dependency.status));
}

function marketplaceCandidateForDependency(state, dependency) {
  return marketplaceItems(state)
    .filter((item) => item.skillId === dependency.id)
    .filter((item) => !dependency.version || compareVersions(item.version, dependency.version) >= 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0] || null;
}

function dependencySuggestionFor(dependency, state) {
  if (!dependency || dependency.status === "satisfied") return null;
  const manifest = catalogById(dependency.id, state);
  const candidate = marketplaceCandidateForDependency(state, dependency);
  const common = {
    id: `${dependency.id}-${dependency.status}`,
    dependencyId: dependency.id,
    dependencyLabel: dependency.label || manifest?.label || candidate?.label || dependency.id,
    requiredVersion: dependency.version || null,
    installedVersion: dependency.installedVersion || null,
    optional: Boolean(dependency.optional),
    currentStatus: dependency.status,
    reason: dependency.reason || ""
  };

  if (["missing", "optional_missing"].includes(dependency.status) && manifest) {
    return {
      ...common,
      action: "install_skill",
      label: `Install ${manifest.label}`,
      command: `POST /api/skills/${dependency.id}/install`,
      autoInstallable: true,
      source: manifest.source || "catalog"
    };
  }

  if (["disabled", "optional_disabled"].includes(dependency.status)) {
    return {
      ...common,
      action: "enable_skill",
      label: `Enable ${common.dependencyLabel}`,
      command: `POST /api/skills/${dependency.id}/enable`,
      autoInstallable: true,
      source: manifest?.source || "catalog"
    };
  }

  if (dependency.status === "version_mismatch" && marketplaceUpdateFor(state, { id: dependency.id, version: dependency.installedVersion || "0.0.0" })) {
    const update = marketplaceUpdateFor(state, { id: dependency.id, version: dependency.installedVersion || "0.0.0" });
    return {
      ...common,
      action: "update_skill",
      label: `Update ${common.dependencyLabel} to ${update.version}`,
      command: `POST /api/skills/${dependency.id}/update`,
      autoInstallable: true,
      source: "marketplace",
      feedId: update.feedId,
      targetVersion: update.version,
      releaseNotes: cleanReleaseNotes(update.releaseNotes, update.version)
    };
  }

  if (candidate) {
    const importAllowed = publisherImportAllowed(state, candidate.publisherFingerprint);
    const trusted = Boolean(state.trustedPublishers?.[candidate.publisherFingerprint]);
    if (!importAllowed) {
      return {
        ...common,
        action: "blocked_by_policy",
        label: `Publisher policy blocks ${candidate.label}`,
        command: "",
        autoInstallable: false,
        source: "marketplace",
        feedId: candidate.feedId,
        publisherFingerprint: candidate.publisherFingerprint,
        targetVersion: candidate.version
      };
    }
    return {
      ...common,
      action: trusted ? "import_marketplace_skill" : "trust_and_import_marketplace_skill",
      label: trusted ? `Import ${candidate.label}` : `Trust publisher and import ${candidate.label}`,
      command: `POST /api/skills/marketplace/feeds/${candidate.feedId}/import/${candidate.skillId}`,
      autoInstallable: true,
      source: "marketplace",
      feedId: candidate.feedId,
      publisherFingerprint: candidate.publisherFingerprint,
      targetVersion: candidate.version,
      requiresTrust: !trusted,
      releaseNotes: cleanReleaseNotes(candidate.releaseNotes, candidate.version)
    };
  }

  return {
    ...common,
    action: dependency.status === "version_mismatch" ? "manual_update_bundle" : "import_signed_bundle",
    label: dependency.status === "version_mismatch"
      ? `Import an updated signed bundle for ${common.dependencyLabel}`
      : `Import signed bundle for ${common.dependencyLabel}`,
    command: "POST /api/skills/import",
    autoInstallable: false,
    source: "manual"
  };
}

function dependencySuggestionsFor(dependencyStatus, state) {
  return (dependencyStatus || [])
    .map((dependency) => dependencySuggestionFor(dependency, state))
    .filter(Boolean);
}

function normalizeSkillManifest(input = {}) {
  const id = safeId(input.id);
  if (!id) {
    const error = new Error("Skill bundle manifest id is required.");
    error.status = 400;
    throw error;
  }
  if (builtinById(id)) {
    const error = new Error(`External skill cannot replace built-in skill: ${id}`);
    error.status = 400;
    throw error;
  }
  return {
    id,
    label: cleanText(input.label, id.replace(/-/g, " "), 80),
    version: cleanVersion(input.version),
    category: cleanText(input.category, "external", 40).toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "external",
    description: cleanText(input.description, "External Hermes skill.", 280),
    requiredKeys: cleanKeyList(input.requiredKeys),
    requiredAnyKeys: cleanRequiredAny(input.requiredAnyKeys),
    optionalKeys: cleanKeyList(input.optionalKeys),
    dependencies: cleanDependencies(input.dependencies, id),
    updateChannel: cleanUpdateChannel(input.updateChannel || input.channel),
    capabilities: cleanWordList(input.capabilities),
    permissions: cleanWordList(input.permissions, ALLOWED_PERMISSIONS),
    releaseNotes: cleanReleaseNotes(input.releaseNotes, cleanVersion(input.version)),
    samplePrompt: cleanText(input.samplePrompt, "", 500),
    exportSafe: Boolean(input.exportSafe ?? true),
    source: "external"
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function canonicalSkillManifest(manifest) {
  return JSON.stringify(canonicalize(normalizeSkillManifest(manifest)));
}

function publicKeyFingerprint(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex");
}

export function signSkillManifest(manifest, privateKeyPem) {
  const body = Buffer.from(canonicalSkillManifest(manifest));
  return crypto.sign(null, body, crypto.createPrivateKey(privateKeyPem)).toString("base64");
}

function verifySkillBundle(bundle = {}) {
  if (bundle.kind !== BUNDLE_KIND) {
    const error = new Error(`Unsupported skill bundle kind: ${bundle.kind || "missing"}`);
    error.status = 400;
    throw error;
  }
  if (Number(bundle.schemaVersion || 0) !== BUNDLE_SCHEMA_VERSION) {
    const error = new Error("Unsupported skill bundle schema version.");
    error.status = 400;
    throw error;
  }
  const manifest = normalizeSkillManifest(bundle.manifest || {});
  const signature = bundle.signature || {};
  if (signature.algorithm !== "ed25519" || !signature.publicKey || !signature.value) {
    const error = new Error("Skill bundle requires an ed25519 signature with publicKey and value.");
    error.status = 400;
    throw error;
  }

  let verified = false;
  let fingerprint = null;
  try {
    const key = crypto.createPublicKey(signature.publicKey);
    verified = crypto.verify(null, Buffer.from(canonicalSkillManifest(manifest)), key, Buffer.from(signature.value, "base64"));
    fingerprint = publicKeyFingerprint(signature.publicKey);
  } catch {
    verified = false;
  }
  if (!verified) {
    const error = new Error("Skill bundle signature verification failed.");
    error.status = 400;
    throw error;
  }

  return {
    manifest,
    signature: {
      algorithm: "ed25519",
      verified: true,
      verifiedAt: now(),
      publicKeyFingerprint: fingerprint
    },
    bundleHash: crypto.createHash("sha256").update(canonicalSkillManifest(manifest)).digest("hex")
  };
}

function marketplaceBundles(body = {}) {
  if (body.kind && body.kind !== FEED_KIND) {
    const error = new Error(`Unsupported marketplace feed kind: ${body.kind}`);
    error.status = 400;
    throw error;
  }
  if (body.schemaVersion != null && Number(body.schemaVersion) !== FEED_SCHEMA_VERSION) {
    const error = new Error("Unsupported marketplace feed schema version.");
    error.status = 400;
    throw error;
  }
  const entries = Array.isArray(body.skills) ? body.skills : Array.isArray(body.bundles) ? body.bundles : [];
  return entries
    .map((entry) => entry?.bundle || entry)
    .filter((entry) => entry && typeof entry === "object")
    .slice(0, 100);
}

async function fetchJsonWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: controller.signal });
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
      error: error?.name === "AbortError" ? "marketplace feed timed out" : error?.message || "marketplace feed fetch failed"
    };
  } finally {
    clearTimeout(timer);
  }
}

function publicTrustedPublisher(fingerprint, record = {}, state = null) {
  const publisherRecord = state?.publishers?.[fingerprint] || {};
  return {
    fingerprint,
    label: publisherRecord.label || record.label || "Trusted publisher",
    trustedAt: record.trustedAt || null,
    source: record.source || "manual",
    notes: record.notes || "",
    allowed: state ? publisherAllowed(state, fingerprint) : false,
    blocked: state ? publisherBlocked(state, fingerprint) : false,
    importAllowed: state ? publisherImportAllowed(state, fingerprint) : true,
    reputation: publicReputation(publisherRecord)
  };
}

function publicFeed(feed = {}, state) {
  const items = state.marketplace?.items?.[feed.id]?.items || [];
  return {
    id: feed.id,
    label: feed.label,
    url: publicUrl(feed.url),
    enabled: feed.enabled !== false,
    lastFetchedAt: feed.lastFetchedAt || null,
    lastStatus: feed.lastStatus || "not_fetched",
    lastError: feed.lastError || null,
    itemCount: items.length
  };
}

function publicMarketplaceItem(item = {}, state) {
  const trusted = Boolean(state.trustedPublishers?.[item.publisherFingerprint]);
  const publisherRecord = state.publishers?.[item.publisherFingerprint] || {};
  const current = state.external?.[item.skillId]?.manifest || null;
  const installed = state.installed?.[item.skillId] || null;
  return {
    feedId: item.feedId,
    skillId: item.skillId,
    label: item.label,
    version: item.version,
    installedVersion: installed?.version || current?.version || null,
    updateAvailable: current ? compareVersions(item.version, current.version) > 0 : false,
    updateChannel: item.updateChannel || "stable",
    category: item.category,
    description: item.description,
    capabilities: item.capabilities || [],
    permissions: item.permissions || [],
    requiredKeys: item.requiredKeys || [],
    requiredAnyKeys: item.requiredAnyKeys || [],
    optionalKeys: item.optionalKeys || [],
    dependencies: item.dependencies || [],
    releaseNotes: cleanReleaseNotes(item.releaseNotes, item.version),
    dependencySuggestions: dependencySuggestionsFor(
      (item.dependencies || []).map((dependency) => ({
        ...dependency,
        label: catalogById(dependency.id, state)?.label || dependency.id,
        installed: Boolean(state.installed?.[dependency.id]),
        enabled: Boolean(state.installed?.[dependency.id]?.enabled),
        installedVersion: state.installed?.[dependency.id]?.version || null,
        status: dependencyStatusFor({ dependencies: [dependency] }, state)[0]?.status || "missing"
      })),
      state
    ),
    exportSafe: Boolean(item.exportSafe),
    bundleHash: item.bundleHash,
    publisherFingerprint: item.publisherFingerprint,
    publisherTrusted: trusted,
    publisherAllowed: publisherAllowed(state, item.publisherFingerprint),
    publisherBlocked: publisherBlocked(state, item.publisherFingerprint),
    publisherImportAllowed: publisherImportAllowed(state, item.publisherFingerprint),
    publisherReputation: publicReputation(publisherRecord),
    signatureVerified: true,
    imported: Boolean(state.external?.[item.skillId]),
    installed: Boolean(state.installed?.[item.skillId]),
    fetchedAt: item.fetchedAt || null,
    source: "marketplace"
  };
}

function findMarketplaceItem(state, feedId, skillId) {
  const feedItems = state.marketplace?.items?.[cleanFeedId(feedId)]?.items || [];
  return feedItems.find((item) => item.skillId === safeId(skillId)) || null;
}

function knownPublisherFingerprints(state) {
  const fingerprints = new Set([
    ...Object.keys(state.publishers || {}),
    ...Object.keys(state.trustedPublishers || {}),
    ...Object.keys(publisherPolicy(state).allowedPublishers || {}),
    ...Object.keys(publisherPolicy(state).blockedPublishers || {})
  ]);
  for (const entry of Object.values(state.external || {})) {
    if (entry?.signature?.publicKeyFingerprint) fingerprints.add(entry.signature.publicKeyFingerprint);
  }
  for (const item of Object.values(state.marketplace.items || {}).flatMap((feed) => Array.isArray(feed.items) ? feed.items : [])) {
    if (item.publisherFingerprint) fingerprints.add(item.publisherFingerprint);
  }
  return Array.from(fingerprints).filter(Boolean).sort();
}

function publicPublisher(fingerprint, state) {
  const publisherRecord = state.publishers?.[fingerprint] || {};
  const trustedRecord = state.trustedPublishers?.[fingerprint] || null;
  const feedItems = Object.values(state.marketplace.items || {})
    .flatMap((feed) => Array.isArray(feed.items) ? feed.items : [])
    .filter((item) => item.publisherFingerprint === fingerprint);
  const externalItems = Object.values(state.external || {})
    .filter((entry) => entry?.signature?.publicKeyFingerprint === fingerprint);
  return {
    fingerprint,
    label: publisherRecord.label || trustedRecord?.label || feedItems[0]?.label || "Publisher",
    website: publisherRecord.website || "",
    trusted: Boolean(trustedRecord),
    trustedAt: trustedRecord?.trustedAt || null,
    allowed: publisherAllowed(state, fingerprint),
    blocked: publisherBlocked(state, fingerprint),
    importAllowed: publisherImportAllowed(state, fingerprint),
    reputation: publicReputation(publisherRecord),
    source: publisherRecord.source || trustedRecord?.source || "discovered",
    feedItems: feedItems.length,
    importedSkills: externalItems.length,
    updatedAt: publisherRecord.updatedAt || trustedRecord?.updatedAt || null
  };
}

export function getSampleSkillManifests() {
  return SKILL_CATALOG.filter((skill) => skill.exportSafe).map((skill) => ({
    id: skill.id,
    label: skill.label,
    version: skill.version,
    category: skill.category,
    description: skill.description,
    capabilities: skill.capabilities,
    requiredKeys: skill.requiredKeys,
    requiredAnyKeys: skill.requiredAnyKeys,
    optionalKeys: skill.optionalKeys,
    dependencies: skill.dependencies || [],
    updateChannel: skill.updateChannel || "stable",
    releaseNotes: cleanReleaseNotes(skill.releaseNotes, skill.version),
    samplePrompt: skill.samplePrompt
  }));
}

export async function getSkillMarketplace() {
  const state = await readState();
  const feeds = Object.values(state.marketplace.feeds || {}).map((feed) => publicFeed(feed, state));
  const items = marketplaceItems(state)
    .map((item) => publicMarketplaceItem(item, state));
  const trustedPublishers = Object.entries(state.trustedPublishers || {})
    .map(([fingerprint, record]) => publicTrustedPublisher(fingerprint, record, state));
  const publishers = knownPublisherFingerprints(state).map((fingerprint) => publicPublisher(fingerprint, state));
  return {
    id: "skill-marketplace",
    schemaVersion: 4,
    summary: {
      feeds: feeds.length,
      enabledFeeds: feeds.filter((feed) => feed.enabled).length,
      items: items.length,
      trustedPublishers: trustedPublishers.length,
      knownPublishers: publishers.length,
      allowedPublishers: publishers.filter((publisher) => publisher.allowed).length,
      blockedPublishers: publishers.filter((publisher) => publisher.blocked).length,
      importAllowedPublishers: publishers.filter((publisher) => publisher.importAllowed).length,
      trustedItems: items.filter((item) => item.publisherTrusted).length,
      allowlistedItems: items.filter((item) => item.publisherAllowed).length,
      blockedItems: items.filter((item) => item.publisherBlocked).length,
      updateItems: items.filter((item) => item.updateAvailable).length,
      untrustedItems: items.filter((item) => !item.publisherTrusted).length,
      importedItems: items.filter((item) => item.imported).length
    },
    policy: publicPublisherPolicy(state),
    feeds,
    items,
    publishers,
    trustedPublishers,
    updatedAt: state.marketplace.updatedAt || state.updatedAt || null
  };
}

export async function getSkillPublishers() {
  const state = await readState();
  const publishers = knownPublisherFingerprints(state).map((fingerprint) => publicPublisher(fingerprint, state));
  return {
    id: "skill-publishers",
    schemaVersion: 1,
    policy: publicPublisherPolicy(state),
    summary: {
      known: publishers.length,
      trusted: publishers.filter((publisher) => publisher.trusted).length,
      allowed: publishers.filter((publisher) => publisher.allowed).length,
      blocked: publishers.filter((publisher) => publisher.blocked).length,
      importAllowed: publishers.filter((publisher) => publisher.importAllowed).length
    },
    publishers,
    updatedAt: state.updatedAt || null
  };
}

export async function saveSkillMarketplaceFeed(input = {}) {
  const state = await readState();
  const id = cleanFeedId(input.id || input.label || input.url);
  const url = validateFeedUrl(input.url);
  const current = state.marketplace.feeds?.[id] || {};
  state.marketplace.feeds = {
    ...(state.marketplace.feeds || {}),
    [id]: {
      ...current,
      id,
      label: cleanText(input.label, current.label || id, 80),
      url,
      enabled: input.enabled == null ? current.enabled !== false : Boolean(input.enabled),
      createdAt: current.createdAt || now(),
      updatedAt: now(),
      lastFetchedAt: current.lastFetchedAt || null,
      lastStatus: current.lastStatus || "not_fetched",
      lastError: current.lastError || null
    }
  };
  state.marketplace.updatedAt = now();
  await writeState(state);
  await appendModuleLog("skill-registry", {
    message: "Skill marketplace feed saved",
    details: {
      feedId: id,
      label: state.marketplace.feeds[id].label,
      url: publicUrl(url)
    }
  });
  return getSkillMarketplace();
}

export async function fetchSkillMarketplaceFeed(feedId) {
  const state = await readState();
  const id = cleanFeedId(feedId);
  const feed = state.marketplace.feeds?.[id];
  if (!feed) {
    const error = new Error(`Skill marketplace feed not found: ${feedId}`);
    error.status = 404;
    throw error;
  }
  const response = await fetchJsonWithTimeout(feed.url);
  if (!response.ok) {
    state.marketplace.feeds[id] = {
      ...feed,
      lastFetchedAt: now(),
      lastStatus: "error",
      lastError: response.error || `HTTP ${response.status}`
    };
    state.marketplace.updatedAt = now();
    await writeState(state);
    return {
      ok: false,
      feed: publicFeed(state.marketplace.feeds[id], state),
      imported: [],
      rejected: [{ reason: state.marketplace.feeds[id].lastError }],
      marketplace: await getSkillMarketplace()
    };
  }

  const bundles = marketplaceBundles(response.body);
  const imported = [];
  const rejected = [];
  for (const bundle of bundles) {
    try {
      const verified = verifySkillBundle(bundle);
      imported.push({
        feedId: id,
        skillId: verified.manifest.id,
        label: verified.manifest.label,
        version: verified.manifest.version,
        category: verified.manifest.category,
        description: verified.manifest.description,
        capabilities: verified.manifest.capabilities,
        permissions: verified.manifest.permissions,
        requiredKeys: verified.manifest.requiredKeys,
        requiredAnyKeys: verified.manifest.requiredAnyKeys,
        optionalKeys: verified.manifest.optionalKeys,
        dependencies: verified.manifest.dependencies,
        updateChannel: verified.manifest.updateChannel,
        releaseNotes: verified.manifest.releaseNotes,
        exportSafe: verified.manifest.exportSafe,
        bundleHash: verified.bundleHash,
        publisherFingerprint: verified.signature.publicKeyFingerprint,
        bundle,
        fetchedAt: now()
      });
    } catch (error) {
      rejected.push({ reason: error?.message || "bundle rejected" });
    }
  }
  state.marketplace.items = {
    ...(state.marketplace.items || {}),
    [id]: {
      fetchedAt: now(),
      items: imported
    }
  };
  state.marketplace.feeds[id] = {
    ...feed,
    lastFetchedAt: now(),
    lastStatus: rejected.length ? "partial" : "fetched",
    lastError: rejected.length ? `${rejected.length} bundle${rejected.length === 1 ? "" : "s"} rejected` : null
  };
  state.marketplace.updatedAt = now();
  await writeState(state);
  await appendModuleLog("skill-registry", {
    message: "Skill marketplace feed fetched",
    details: {
      feedId: id,
      accepted: imported.length,
      rejected: rejected.length,
      latencyMs: response.latencyMs
    }
  });
  return {
    ok: true,
    feed: publicFeed(state.marketplace.feeds[id], state),
    imported: imported.map((item) => publicMarketplaceItem(item, state)),
    rejected,
    marketplace: await getSkillMarketplace()
  };
}

export async function trustSkillPublisher(fingerprint, input = {}) {
  const clean = cleanFingerprint(fingerprint);
  if (!clean) {
    const error = new Error("Publisher fingerprint must be a 64-character sha256 hex value.");
    error.status = 400;
    throw error;
  }
  const state = await readState();
  state.trustedPublishers = {
    ...(state.trustedPublishers || {}),
    [clean]: {
      label: cleanText(input.label, "Trusted publisher", 80),
      notes: cleanText(input.notes, "", 200),
      source: cleanText(input.source, "manual", 40),
      trustedAt: state.trustedPublishers?.[clean]?.trustedAt || now(),
      updatedAt: now()
    }
  };
  await writeState(state);
  await appendModuleLog("skill-registry", {
    message: "Skill publisher trusted",
    details: { fingerprint: clean, label: state.trustedPublishers[clean].label }
  });
  return getSkillMarketplace();
}

export async function untrustSkillPublisher(fingerprint) {
  const clean = cleanFingerprint(fingerprint);
  if (!clean) {
    const error = new Error("Publisher fingerprint must be a 64-character sha256 hex value.");
    error.status = 400;
    throw error;
  }
  const state = await readState();
  state.trustedPublishers = { ...(state.trustedPublishers || {}) };
  delete state.trustedPublishers[clean];
  await writeState(state);
  await appendModuleLog("skill-registry", {
    message: "Skill publisher trust removed",
    details: { fingerprint: clean }
  });
  return getSkillMarketplace();
}

export async function updateSkillPublisherPolicy(input = {}) {
  const state = await readState();
  state.marketplace.policy = {
    ...publisherPolicy(state),
    enforceAllowlist: Boolean(input.enforceAllowlist),
    updatedAt: now()
  };
  state.marketplace.updatedAt = now();
  await writeState(state);
  await appendModuleLog("skill-registry", {
    message: "Skill publisher policy updated",
    details: { enforceAllowlist: state.marketplace.policy.enforceAllowlist }
  });
  return getSkillMarketplace();
}

export async function updateSkillPublisherReputation(fingerprint, input = {}) {
  const clean = cleanFingerprint(fingerprint);
  if (!clean) {
    const error = new Error("Publisher fingerprint must be a 64-character sha256 hex value.");
    error.status = 400;
    throw error;
  }
  const score = cleanReputationScore(input.score);
  const state = await readState();
  const current = state.publishers?.[clean] || {};
  state.publishers = {
    ...(state.publishers || {}),
    [clean]: {
      ...current,
      label: cleanText(input.label, current.label || "Publisher", 80),
      website: cleanText(input.website, current.website || "", 160),
      source: cleanText(input.source, current.source || "manual", 40),
      reputation: {
        score,
        tier: cleanReputationTier(input.tier || current.reputation?.tier, score),
        source: cleanText(input.reputationSource || input.source, current.reputation?.source || "manual", 40),
        notes: cleanText(input.notes, current.reputation?.notes || "", 240),
        updatedAt: now()
      },
      updatedAt: now()
    }
  };
  await writeState(state);
  await appendModuleLog("skill-registry", {
    message: "Skill publisher reputation updated",
    details: {
      fingerprint: clean,
      label: state.publishers[clean].label,
      tier: state.publishers[clean].reputation.tier,
      score
    }
  });
  return getSkillPublishers();
}

export async function setSkillPublisherAllowed(fingerprint, allowed = true, input = {}) {
  const clean = cleanFingerprint(fingerprint);
  if (!clean) {
    const error = new Error("Publisher fingerprint must be a 64-character sha256 hex value.");
    error.status = 400;
    throw error;
  }
  const state = await readState();
  const policy = publisherPolicy(state);
  policy.allowedPublishers = { ...(policy.allowedPublishers || {}) };
  if (allowed) {
    policy.allowedPublishers[clean] = {
      allowedAt: policy.allowedPublishers[clean]?.allowedAt || now(),
      label: cleanText(input.label, state.publishers?.[clean]?.label || state.trustedPublishers?.[clean]?.label || "Allowed publisher", 80),
      notes: cleanText(input.notes, "", 200)
    };
  } else {
    delete policy.allowedPublishers[clean];
  }
  policy.updatedAt = now();
  state.marketplace.policy = policy;
  state.marketplace.updatedAt = now();
  await writeState(state);
  await appendModuleLog("skill-registry", {
    message: allowed ? "Skill publisher allowed" : "Skill publisher removed from allowlist",
    details: { fingerprint: clean }
  });
  return getSkillPublishers();
}

export async function setSkillPublisherBlocked(fingerprint, blocked = true, input = {}) {
  const clean = cleanFingerprint(fingerprint);
  if (!clean) {
    const error = new Error("Publisher fingerprint must be a 64-character sha256 hex value.");
    error.status = 400;
    throw error;
  }
  const state = await readState();
  const policy = publisherPolicy(state);
  policy.blockedPublishers = { ...(policy.blockedPublishers || {}) };
  if (blocked) {
    policy.blockedPublishers[clean] = {
      blockedAt: policy.blockedPublishers[clean]?.blockedAt || now(),
      reason: cleanText(input.reason || input.notes, "Manual block", 200)
    };
  } else {
    delete policy.blockedPublishers[clean];
  }
  policy.updatedAt = now();
  state.marketplace.policy = policy;
  state.marketplace.updatedAt = now();
  await writeState(state);
  await appendModuleLog("skill-registry", {
    message: blocked ? "Skill publisher blocked" : "Skill publisher block removed",
    details: { fingerprint: clean }
  });
  return getSkillPublishers();
}

export async function importMarketplaceSkill(feedId, skillId, input = {}) {
  let state = await readState();
  const item = findMarketplaceItem(state, feedId, skillId);
  if (!item) {
    const error = new Error(`Marketplace skill not found: ${skillId}`);
    error.status = 404;
    throw error;
  }
  const trusted = Boolean(state.trustedPublishers?.[item.publisherFingerprint]);
  if (publisherBlocked(state, item.publisherFingerprint)) {
    const error = new Error(`Publisher ${item.publisherFingerprint} is blocked by policy.`);
    error.status = 409;
    throw error;
  }
  if (!publisherImportAllowed(state, item.publisherFingerprint)) {
    const error = new Error(`Publisher ${item.publisherFingerprint} is not on the allowed publisher list.`);
    error.status = 409;
    throw error;
  }
  if (!trusted && !input.trustPublisher) {
    const error = new Error(`Publisher ${item.publisherFingerprint} is not trusted.`);
    error.status = 409;
    throw error;
  }
  if (!trusted && input.trustPublisher) {
    await trustSkillPublisher(item.publisherFingerprint, {
      label: input.publisherLabel || item.label,
      source: `feed:${cleanFeedId(feedId)}`,
      notes: "Trusted during marketplace import."
    });
    state = await readState();
  }
  const imported = await importSkillBundle(item.bundle);
  await appendModuleLog(skillLogId(item.skillId), {
    message: "Marketplace skill imported",
    details: {
      feedId: cleanFeedId(feedId),
      skillId: item.skillId,
      publicKeyFingerprint: item.publisherFingerprint,
      trustedPublisher: true
    }
  });
  return {
    ...imported,
    marketplace: await getSkillMarketplace()
  };
}

export async function getSkillRegistry() {
  const state = await readState();
  const skills = allCatalogSkills(state).map((skill) => publicSkill(skill, state.installed?.[skill.id] || null, state));
  const publicMarketplaceItems = marketplaceItems(state)
    .map((item) => publicMarketplaceItem(item, state));
  const publishers = knownPublisherFingerprints(state).map((fingerprint) => publicPublisher(fingerprint, state));
  const summary = {
    total: skills.length,
    installed: skills.filter((skill) => skill.installed).length,
    enabled: skills.filter((skill) => skill.status === "enabled").length,
    disabled: skills.filter((skill) => skill.status === "disabled").length,
    setup: skills.filter((skill) => skill.status === "ready_to_configure").length,
    available: skills.filter((skill) => skill.status === "available").length,
    external: skills.filter((skill) => skill.source === "external").length,
    signed: skills.filter((skill) => skill.signatureVerified).length,
    updates: skills.filter((skill) => skill.updateAvailable).length,
    trustedPublishers: Object.keys(state.trustedPublishers || {}).length,
    untrustedExternal: skills.filter((skill) => skill.source === "external" && !skill.publisherTrusted).length,
    marketplaceFeeds: Object.keys(state.marketplace.feeds || {}).length,
    marketplaceItems: publicMarketplaceItems.length,
    marketplaceTrustedItems: publicMarketplaceItems.filter((item) => item.publisherTrusted).length,
    marketplaceUpdateItems: publicMarketplaceItems.filter((item) => item.updateAvailable).length,
    knownPublishers: publishers.length,
    allowedPublishers: publishers.filter((publisher) => publisher.allowed).length,
    blockedPublishers: publishers.filter((publisher) => publisher.blocked).length,
    dependencyBlocked: skills.filter((skill) => !skill.dependencyReady).length,
    dependencySuggestions: skills.reduce((total, skill) => total + (skill.dependencySuggestions?.length || 0), 0),
    allowlistEnforced: publisherPolicy(state).enforceAllowlist
  };
  return {
    id: "skill-registry",
    schemaVersion: 6,
    summary,
    skills,
    updatedAt: state.updatedAt || null
  };
}

export async function getSkill(id) {
  const state = await readState();
  const skill = catalogById(safeId(id), state);
  if (!skill) return null;
  return publicSkill(skill, state.installed?.[skill.id] || null, state);
}

export async function prepareSkillDependencies(id, input = {}) {
  const state = await readState();
  const skill = catalogById(safeId(id), state);
  if (!skill) {
    const error = new Error(`Skill not found: ${id}`);
    error.status = 404;
    throw error;
  }
  const publicRecord = publicSkill(skill, state.installed?.[skill.id] || null, state);
  const suggestions = publicRecord.dependencySuggestions || [];
  const requiredSuggestions = suggestions.filter((suggestion) => !suggestion.optional);
  const mode = "dry_run";
  const result = {
    ok: publicRecord.dependencyReady,
    id: "skill-dependency-prepare",
    skillId: skill.id,
    generatedAt: now(),
    mode,
    executeRequested: Boolean(input.execute),
    executed: false,
    dependencyReady: publicRecord.dependencyReady,
    dependencyStatus: publicRecord.dependencyStatus,
    suggestions,
    releaseNotes: publicRecord.releaseNotes,
    nextActions: suggestions.map((suggestion) => ({
      action: suggestion.action,
      label: suggestion.label,
      command: suggestion.command,
      autoInstallable: suggestion.autoInstallable
    })),
    message: publicRecord.dependencyReady
      ? `${skill.label} dependencies are ready.`
      : `${skill.label} needs ${requiredSuggestions.length} required dependenc${requiredSuggestions.length === 1 ? "y" : "ies"} before it can be enabled.`
  };
  await appendModuleLog(skillLogId(skill.id), {
    message: "Skill dependency install suggestions prepared",
    details: {
      skillId: skill.id,
      dependencyReady: result.dependencyReady,
      suggestions: suggestions.map((suggestion) => ({
        dependencyId: suggestion.dependencyId,
        action: suggestion.action,
        source: suggestion.source,
        autoInstallable: suggestion.autoInstallable
      }))
    }
  });
  return result;
}

export async function importSkillBundle(bundle = {}) {
  const verified = verifySkillBundle(bundle);
  const state = await readState();
  const current = state.external?.[verified.manifest.id] || null;
  const currentFingerprint = current?.signature?.publicKeyFingerprint;
  if (currentFingerprint && currentFingerprint !== verified.signature.publicKeyFingerprint && !bundle.allowPublisherRotation) {
    const error = new Error(`Publisher fingerprint mismatch for ${verified.manifest.id}.`);
    error.status = 409;
    throw error;
  }
  state.external = {
    ...(state.external || {}),
    [verified.manifest.id]: {
      manifest: verified.manifest,
      signature: verified.signature,
      bundleHash: verified.bundleHash,
      importedAt: current?.importedAt || now(),
      updatedAt: now()
    }
  };
  await writeState(state);
  await appendModuleLog(skillLogId(verified.manifest.id), {
    message: current ? "External skill bundle updated" : "External skill bundle imported",
    details: {
      skillId: verified.manifest.id,
      version: verified.manifest.version,
      permissions: verified.manifest.permissions,
      signatureVerified: true,
      publicKeyFingerprint: verified.signature.publicKeyFingerprint
    }
  });
  return {
    skill: await getSkill(verified.manifest.id),
    verification: {
      ok: true,
      algorithm: verified.signature.algorithm,
      publicKeyFingerprint: verified.signature.publicKeyFingerprint,
      bundleHash: verified.bundleHash
    }
  };
}

function dependencyError(skill, state, action) {
  const blocked = blockingDependencies(skill, state);
  if (!blocked.length) return null;
  const error = new Error(`Cannot ${action} ${skill.id}; missing required dependencies: ${blocked.map((dependency) => dependency.id).join(", ")}.`);
  error.status = 409;
  error.dependencies = blocked;
  return error;
}

export async function installSkill(id, options = {}) {
  const state = await readState();
  const skill = catalogById(safeId(id), state);
  if (!skill) {
    const error = new Error(`Skill not found: ${id}`);
    error.status = 404;
    throw error;
  }
  const blockedDependencyError = dependencyError(skill, state, "install");
  if (blockedDependencyError && !options.allowMissingDependencies) throw blockedDependencyError;
  const blocked = blockingDependencies(skill, state);
  const current = state.installed?.[skill.id] || {};
  state.installed = {
    ...(state.installed || {}),
    [skill.id]: {
      ...current,
      id: skill.id,
      version: skill.version,
      enabled: blocked.length ? false : current.enabled ?? true,
      fields: current.fields || {},
      source: skill.source || "built_in",
      installedAt: current.installedAt || now(),
      updatedAt: now()
    }
  };
  await writeState(state);
  await appendModuleLog(skillLogId(skill.id), {
    message: "Skill installed",
    details: { skillId: skill.id, version: skill.version, dependencyOverride: Boolean(blocked.length && options.allowMissingDependencies) }
  });
  return getSkill(skill.id);
}

export async function uninstallSkill(id, { removeBundle = false } = {}) {
  const state = await readState();
  const clean = safeId(id);
  const skill = catalogById(clean, state);
  if (!skill) {
    const error = new Error(`Skill not found: ${id}`);
    error.status = 404;
    throw error;
  }
  const installed = state.installed?.[clean];
  state.installed = { ...(state.installed || {}) };
  delete state.installed[clean];
  if (removeBundle && state.external?.[clean]) {
    state.external = { ...(state.external || {}) };
    delete state.external[clean];
  }
  await writeState(state);
  await appendModuleLog(skillLogId(clean), {
    message: removeBundle ? "External skill bundle removed" : "Skill uninstalled",
    details: { skillId: clean, wasInstalled: Boolean(installed), removeBundle: Boolean(removeBundle) }
  });
  return getSkill(clean);
}

export async function configureSkill(id, fields = {}) {
  const state = await readState();
  const skill = catalogById(safeId(id), state);
  if (!skill) {
    const error = new Error(`Skill not found: ${id}`);
    error.status = 404;
    throw error;
  }
  const current = state.installed?.[skill.id];
  if (!current) {
    const error = new Error(`Install skill before configuring: ${skill.id}`);
    error.status = 400;
    throw error;
  }
  const cleaned = cleanFields(fields);
  state.installed[skill.id] = {
    ...current,
    fields: {
      ...(current.fields || {}),
      ...cleaned
    },
    updatedAt: now()
  };
  await writeState(state);
  await appendModuleLog(skillLogId(skill.id), {
    message: "Skill configuration saved",
    details: { configuredFields: Object.keys(state.installed[skill.id].fields || {}) }
  });
  return getSkill(skill.id);
}

export async function setSkillEnabled(id, enabled) {
  const state = await readState();
  const skill = catalogById(safeId(id), state);
  if (!skill) {
    const error = new Error(`Skill not found: ${id}`);
    error.status = 404;
    throw error;
  }
  const current = state.installed?.[skill.id];
  if (!current) {
    const error = new Error(`Install skill before toggling: ${skill.id}`);
    error.status = 400;
    throw error;
  }
  if (enabled) {
    const blockedDependencyError = dependencyError(skill, state, "enable");
    if (blockedDependencyError) throw blockedDependencyError;
  }
  state.installed[skill.id] = {
    ...current,
    enabled: Boolean(enabled),
    updatedAt: now()
  };
  await writeState(state);
  await appendModuleLog(skillLogId(skill.id), {
    message: enabled ? "Skill enabled" : "Skill disabled",
    details: { skillId: skill.id }
  });
  return getSkill(skill.id);
}

export async function updateSkill(id, input = {}) {
  let state = await readState();
  let skill = catalogById(safeId(id), state);
  if (!skill) {
    const error = new Error(`Skill not found: ${id}`);
    error.status = 404;
    throw error;
  }
  const current = state.installed?.[skill.id];
  if (!current) {
    const error = new Error(`Install skill before updating: ${skill.id}`);
    error.status = 400;
    throw error;
  }
  const marketplaceUpdate = marketplaceUpdateFor(state, skill);
  if (marketplaceUpdate) {
    if (publisherBlocked(state, marketplaceUpdate.publisherFingerprint)) {
      const error = new Error(`Publisher ${marketplaceUpdate.publisherFingerprint} is blocked by policy.`);
      error.status = 409;
      throw error;
    }
    if (!publisherImportAllowed(state, marketplaceUpdate.publisherFingerprint)) {
      const error = new Error(`Publisher ${marketplaceUpdate.publisherFingerprint} is not on the allowed publisher list.`);
      error.status = 409;
      throw error;
    }
    const trusted = Boolean(state.trustedPublishers?.[marketplaceUpdate.publisherFingerprint]);
    if (!trusted && !input.trustPublisher) {
      const error = new Error(`Publisher ${marketplaceUpdate.publisherFingerprint} is not trusted.`);
      error.status = 409;
      throw error;
    }
    if (!trusted && input.trustPublisher) {
      await trustSkillPublisher(marketplaceUpdate.publisherFingerprint, {
        label: input.publisherLabel || marketplaceUpdate.label,
        source: `feed:${cleanFeedId(marketplaceUpdate.feedId)}`,
        notes: "Trusted during marketplace skill update."
      });
    }
    await importSkillBundle(marketplaceUpdate.bundle);
    state = await readState();
    skill = catalogById(safeId(id), state);
  }

  const blockedDependencyError = dependencyError(skill, state, "update");
  if (blockedDependencyError && !input.allowMissingDependencies) throw blockedDependencyError;
  const blocked = blockingDependencies(skill, state);
  state.installed[skill.id] = {
    ...(state.installed?.[skill.id] || current),
    version: skill.version,
    enabled: blocked.length ? false : state.installed?.[skill.id]?.enabled ?? current.enabled,
    updatedAt: now()
  };
  await writeState(state);
  await appendModuleLog(skillLogId(skill.id), {
    message: marketplaceUpdate ? "Marketplace skill updated" : "Skill version synced",
    details: {
      skillId: skill.id,
      version: skill.version,
      updateChannel: skill.updateChannel || "stable",
      sourceFeedId: marketplaceUpdate?.feedId || null,
      dependencyOverride: Boolean(blocked.length && input.allowMissingDependencies)
    }
  });
  return {
    skill: await getSkill(skill.id),
    marketplace: await getSkillMarketplace()
  };
}

export async function testSkill(id) {
  const state = await readState();
  const skill = catalogById(safeId(id), state);
  if (!skill) {
    return { ok: false, id, status: "not_found", message: `Skill not found: ${id}`, details: null };
  }
  const record = state.installed?.[skill.id] || null;
  const publicRecord = publicSkill(skill, record, state);
  const ok = publicRecord.status === "enabled";
  if (record) {
    state.installed[skill.id] = { ...record, lastTestedAt: now(), updatedAt: now() };
    await writeState(state);
  }
  await appendModuleLog(skillLogId(skill.id), {
    level: ok ? "info" : "warn",
    message: "Skill tested",
    details: {
      status: publicRecord.status,
      missing: publicRecord.missing,
      configuredFields: publicRecord.configuredFields
    }
  });
  return {
    ok,
    id: skill.id,
    status: publicRecord.status,
    message: ok
      ? `${skill.label} is installed, enabled, and configured.`
      : `${skill.label} is ${publicRecord.status}.`,
    details: sanitizeObject(publicRecord)
  };
}

export async function getSkillLogs(id) {
  return readModuleLogs(skillLogId(id));
}

export async function getSkillRegistryOverview() {
  const registry = await getSkillRegistry();
  return registry.summary;
}
