import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendModuleLog } from "./module-logs.js";
import { addMemory } from "./memory.js";
import { getConfiguredValue, getStoredConnectionConfig } from "./connections.js";
import { getExecutionGateStatus, isExecutionEnabled } from "./execution-gate.js";
import { expandHome, runtimePaths } from "./store.js";
import { redactText, runCommand, sanitizeObject, which } from "./safety.js";

const MODULE_ID = "voice-control";
const WAKE_WORDS = ["hermes", "hey hermes", "ok hermes", "okay hermes"];
const ACTION_LIMIT = 8;
const SPECIAL_FOLDERS = {
  desktop: "~/Desktop",
  downloads: "~/Downloads",
  documents: "~/Documents",
  pictures: "~/Pictures",
  music: "~/Music",
  movies: "~/Movies",
  applications: "/Applications",
  home: "~"
};
const KEY_ALIASES = {
  enter: { keyCode: 36 },
  return: { keyCode: 36 },
  tab: { keyCode: 48 },
  escape: { keyCode: 53 },
  esc: { keyCode: 53 },
  space: { keyCode: 49 },
  delete: { keyCode: 51 },
  backspace: { keyCode: 51 },
  left: { keyCode: 123 },
  right: { keyCode: 124 },
  down: { keyCode: 125 },
  up: { keyCode: 126 },
  pageup: { keyCode: 116 },
  pagedown: { keyCode: 121 }
};

function now() {
  return new Date().toISOString();
}

function commandId(prefix = "voice") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanText(value, max = 4000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function voiceConfig(stored = {}, key, fallback = "") {
  return getConfiguredValue(stored, MODULE_ID, key) || fallback || "";
}

function configFlag(value, defaultValue = false) {
  if (value == null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function voiceModel(stored = {}) {
  return voiceConfig(stored, "HERMES_VOICE_MODEL", process.env.HERMES_VOICE_MODEL || process.env.CODEX_GPT_MODEL || "gpt-5");
}

function voicePlannerDisabled(stored = {}) {
  return String(voiceConfig(stored, "HERMES_VOICE_USE_CODEX_GPT", process.env.HERMES_VOICE_USE_CODEX_GPT || "")).trim() === "0";
}

function voiceShellAllowed(stored = {}) {
  return configFlag(voiceConfig(stored, "HERMES_VOICE_ALLOW_SHELL", process.env.HERMES_VOICE_ALLOW_SHELL || ""), false);
}

function voiceOpenAiUrl(stored = {}) {
  return voiceConfig(stored, "HERMES_VOICE_OPENAI_URL", process.env.HERMES_VOICE_OPENAI_URL || "https://api.openai.com/v1/chat/completions");
}

function voiceCodexTimeoutMs(stored = {}) {
  const value = Number(voiceConfig(stored, "HERMES_VOICE_CODEX_TIMEOUT_MS", process.env.HERMES_VOICE_CODEX_TIMEOUT_MS || 300000));
  return Number.isFinite(value) && value > 0 ? value : 300000;
}

function stripWakeWord(transcript) {
  let text = cleanText(transcript);
  const lower = text.toLowerCase();
  for (const wake of WAKE_WORDS) {
    if (lower === wake) return "";
    if (lower.startsWith(`${wake} `)) return text.slice(wake.length).trim();
    if (lower.startsWith(`${wake},`)) return text.slice(wake.length + 1).trim();
  }
  return text;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function appNameFrom(text) {
  const match = text.match(/\b(?:open|launch|start|switch to|activate)\s+(.+?)\s*$/i);
  if (!match) return "";
  return cleanText(match[1], 80)
    .replace(/\bapp\b$/i, "")
    .replace(/\bplease\b/i, "")
    .trim();
}

function searchQueryFrom(text) {
  const match = text.match(/\b(?:search|google|look up|find online|browse for)\s+(.+?)\s*$/i);
  return match ? cleanText(match[1], 300) : "";
}

function sequentialPartsFrom(text) {
  return cleanText(text)
    .split(/\s+(?:and\s+then|then|after\s+that)\s+/i)
    .map((item) => cleanText(item, 500))
    .filter(Boolean);
}

function urlFrom(text) {
  const url = text.match(/https?:\/\/[^\s]+/i)?.[0];
  if (url) return url;
  const match = text.match(/\b(?:open|go to|browse to|visit)\s+([a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?)/i);
  if (!match) return "";
  return `https://${match[1]}`;
}

function typedTextFrom(text) {
  const quoted = text.match(/(?:type|write|enter)\s+["“](.+?)["”]\s*$/i);
  if (quoted) return cleanText(quoted[1], 2000);
  const match = text.match(/\b(?:type|write|enter)\s+(.+?)\s*$/i);
  return match ? cleanText(match[1], 2000) : "";
}

function fileQueryFrom(text) {
  const match = text.match(/\b(?:find|search for|locate|show me)\s+(?:the\s+)?(?:file|folder|document|download)?\s*(.+?)\s*$/i);
  return match ? cleanText(match[1], 180) : "";
}

function openFileTargetFrom(text) {
  const match = text.match(/\b(?:open|show|reveal)\s+(?:the\s+)?(?:file|folder|document)?\s*(.+?)\s*$/i);
  return match ? cleanText(match[1], 300) : "";
}

function folderBaseFromText(text) {
  const lower = cleanText(text).toLowerCase();
  const match = lower.match(/\b(?:in|on|inside)\s+(?:the\s+)?(desktop|downloads|documents|pictures|music|movies|home)\b/);
  const name = match?.[1] || "desktop";
  return SPECIAL_FOLDERS[name] || SPECIAL_FOLDERS.desktop;
}

function safeFolderNameFrom(text) {
  const name = cleanText(text, 120)
    .replace(/\s+\b(?:in|on|inside)\s+(?:the\s+)?(?:desktop|downloads|documents|pictures|music|movies|home)\b.*$/i, "")
    .trim();
  if (!name || name === "." || name === ".." || /[/:\\]/.test(name) || name.includes("..")) return "";
  return name;
}

function createFolderFrom(text) {
  if (!/\b(?:create|make|new)\s+(?:a\s+)?(?:new\s+)?folder\b/i.test(text)) return null;
  const quoted = text.match(/\bfolder\s+(?:called|named)?\s*["“](.+?)["”]/i)?.[1];
  const named = text.match(/\bfolder\s+(?:called|named)\s+(.+?)\s*$/i)?.[1];
  const bare = text.match(/\b(?:create|make|new)\s+(?:a\s+)?(?:new\s+)?folder\s+(.+?)\s*$/i)?.[1];
  const name = safeFolderNameFrom(quoted || named || bare || "");
  if (!name) return null;
  const base = folderBaseFromText(text);
  return { name, path: `${base === "~" ? "~" : base}/${name}` };
}

function wantsTrashSelection(text) {
  const lower = cleanText(text).toLowerCase();
  return /\b(?:move|send|put|delete|trash)\b/.test(lower) &&
    /\b(?:selected|selection|current file|this file|these files|selected files|selected items)\b/.test(lower) &&
    /\b(?:trash|delete)\b/.test(lower);
}

function specialFolderFrom(text) {
  const lower = cleanText(text).toLowerCase();
  for (const [name, folderPath] of Object.entries(SPECIAL_FOLDERS)) {
    if (new RegExp(`\\b${name}\\b`).test(lower) && /\b(open|show|reveal|go to)\b/.test(lower)) {
      return { name, path: folderPath };
    }
  }
  return null;
}

function pageSearchFrom(text) {
  const match = text.match(/\b(?:find on page|search this page|find in page|page search)\s+(.+?)\s*$/i);
  return match ? cleanText(match[1], 300) : "";
}

function browserSearchFlowFrom(text) {
  const match = text.match(/\b(?:open\s+(?:a\s+)?new\s+tab|new\s+tab)\s+(?:and\s+|then\s+)?(?:search|google|look up|find online|browse for)\s+(.+?)\s*$/i);
  if (!match) return null;
  const query = cleanText(match[1].replace(/^(?:for|about)\s+/i, ""), 300);
  return query ? { query } : null;
}

function appTargetFromWindowControl(raw) {
  const target = cleanText(raw, 120)
    .replace(/^(?:the\s+)?/i, "")
    .replace(/\b(?:app|application|window|windows)\b$/i, "")
    .trim();
  if (!target || /^(this|current|front|active|window|screen|mode|app|application)$/i.test(target)) return "";
  if (/^(this|current|front|active)\s+(?:app|application|window)$/i.test(target)) return "";
  return target;
}

function windowControlFrom(text) {
  const lower = cleanText(text).toLowerCase();
  if (/\b(show|reveal)\s+(?:the\s+)?desktop\b/.test(lower) && !/\bfolder\b/.test(lower)) {
    return { operation: "show_desktop", label: "show desktop" };
  }
  const quitNamed = text.match(/\bquit\s+(.+?)\s*$/i);
  if (quitNamed) {
    const app = appTargetFromWindowControl(quitNamed[1]);
    if (app) return { operation: "quit_app", app, label: `quit ${app}` };
  }
  const hideNamed = text.match(/\bhide\s+(.+?)\s*$/i);
  if (hideNamed) {
    const app = appTargetFromWindowControl(hideNamed[1]);
    if (app) return { operation: "hide_app", app, label: `hide ${app}` };
  }
  const minimizeNamed = text.match(/\b(?:minimi[sz]e|put away)\s+(.+?)\s*$/i);
  if (minimizeNamed) {
    const app = appTargetFromWindowControl(minimizeNamed[1]);
    if (app) return { operation: "minimize_window", app, label: `minimize ${app}` };
  }
  const maximizeNamed = text.match(/\b(?:maximi[sz]e|zoom)\s+(.+?)\s*$/i);
  if (maximizeNamed) {
    const app = appTargetFromWindowControl(maximizeNamed[1]);
    if (app) return { operation: "maximize_window", app, label: `maximize ${app}` };
  }
  const fullScreenNamed = text.match(/\b(?:make\s+)?(.+?)\s+(?:full\s*screen|fullscreen)\s*$/i);
  if (fullScreenNamed) {
    const app = appTargetFromWindowControl(fullScreenNamed[1]);
    if (app) return { operation: "toggle_full_screen", app, label: `toggle ${app} full screen` };
  }
  if (/\b(minimi[sz]e|put away)\b/.test(lower) && /\b(window|this|current|screen)\b/.test(lower)) {
    return { operation: "minimize_window", label: "minimize the front window" };
  }
  if (/\b(maximi[sz]e|zoom)\b/.test(lower) && /\b(window|this|current|screen)\b/.test(lower)) {
    return { operation: "maximize_window", label: "maximize the front window" };
  }
  if (/\b(full\s*screen|fullscreen)\b/.test(lower) && /\b(window|this|current|screen|mode)\b/.test(lower)) {
    return { operation: "toggle_full_screen", label: "toggle full screen" };
  }
  if (/\bhide\s+(?:this\s+)?(?:app|application|current app)\b|\bhide\s+(?:the\s+)?front\s+app\b/.test(lower)) {
    return { operation: "hide_app", label: "hide the front app" };
  }
  if (/\bquit\s+(?:this\s+)?(?:app|application|current app)\b|\bclose\s+(?:this\s+)?app\b/.test(lower)) {
    return { operation: "quit_app", label: "quit the front app" };
  }
  return null;
}

function workflowIdFrom(text) {
  const match = text.match(/\b(?:run|start|execute|open)\s+(?:the\s+)?(?:workflow|flow|agent workflow)\s+(.+?)\s*$/i);
  if (!match) return "";
  const raw = cleanText(match[1], 160);
  if (!raw) return "";
  if (/blank|starter|start/i.test(raw) && /builder|agent/i.test(raw)) return "blank-open-agent-builder";
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function moduleRunFrom(text) {
  const match = text.match(/\b(?:ask|run|tell|use)\s+(hermes|codex|claude|gemini|opencode|openclaw|provider router|openai|ollama)\s+(?:to\s+)?(.+?)\s*$/i);
  if (!match) return null;
  const rawId = match[1].toLowerCase().replace(/\s+/g, "-");
  const idMap = {
    "provider-router": "provider-router",
    openai: "provider-openai",
    ollama: "provider-ollama"
  };
  return {
    moduleId: idMap[rawId] || rawId,
    message: cleanText(match[2], 2000)
  };
}

function pasteTextFrom(text) {
  const quoted = text.match(/(?:paste|put)\s+["“](.+?)["”]\s*$/i);
  if (quoted) return cleanText(quoted[1], 2000);
  const match = text.match(/\b(?:paste|put)\s+(.+?)\s*$/i);
  return match ? cleanText(match[1], 2000) : "";
}

function hotkeyFrom(text) {
  const lower = cleanText(text).toLowerCase();
  if (/\b(?:go|navigate|browser)\s+back\b|\bprevious\s+page\b/.test(lower)) return { key: "[", modifiers: ["command"], label: "back" };
  if (/\b(?:go|navigate|browser)\s+forward\b|\bnext\s+page\b/.test(lower)) return { key: "]", modifiers: ["command"], label: "forward" };
  if (/\b(?:focus|select|go to|open)\s+(?:the\s+)?(?:address|location|url)\s+bar\b/.test(lower)) return { key: "l", modifiers: ["command"], label: "address bar" };
  if (/\b(select all)\b/.test(lower)) return { key: "a", modifiers: ["command"], label: "select all" };
  if (/\b(copy)\b/.test(lower)) return { key: "c", modifiers: ["command"], label: "copy" };
  if (/\b(cut)\b/.test(lower)) return { key: "x", modifiers: ["command"], label: "cut" };
  if (/\b(paste)\b/.test(lower) && !pasteTextFrom(text)) return { key: "v", modifiers: ["command"], label: "paste" };
  if (/\b(undo)\b/.test(lower)) return { key: "z", modifiers: ["command"], label: "undo" };
  if (/\b(redo)\b/.test(lower)) return { key: "z", modifiers: ["command", "shift"], label: "redo" };
  if (/\b(save)\b/.test(lower)) return { key: "s", modifiers: ["command"], label: "save" };
  if (/\b(close tab|close window)\b/.test(lower)) return { key: "w", modifiers: ["command"], label: "close" };
  if (/\b(new tab)\b/.test(lower)) return { key: "t", modifiers: ["command"], label: "new tab" };
  if (/\b(refresh|reload)\b/.test(lower)) return { key: "r", modifiers: ["command"], label: "reload" };
  const press = lower.match(/\b(?:press|hit)\s+(enter|return|tab|escape|esc|space|delete|backspace|left|right|up|down|pageup|pagedown)\b/);
  if (press) return { key: press[1], modifiers: [], label: press[1] };
  return null;
}

function scrollFrom(text) {
  const lower = cleanText(text).toLowerCase();
  if (/\bscroll\s+down\b/.test(lower)) return { direction: "down", amount: 6 };
  if (/\bscroll\s+up\b/.test(lower)) return { direction: "up", amount: 6 };
  if (/\bscroll\s+left\b/.test(lower)) return { direction: "left", amount: 6 };
  if (/\bscroll\s+right\b/.test(lower)) return { direction: "right", amount: 6 };
  return null;
}

function clickTextFrom(text) {
  const match = text.match(/\b(?:click|press|choose|select)\s+(?:the\s+)?(?:button|link|menu|item)?\s*["“]?(.+?)["”]?\s*$/i);
  if (!match || /\d{1,5}\s*[,x]\s*\d{1,5}/.test(text)) return "";
  const label = cleanText(match[1], 120);
  if (!label || /^(at|on|there|here)$/i.test(label)) return "";
  return label;
}

function wantsDesktopContext(text) {
  return /\b(what'?s on screen|what do you see|inspect screen|inspect the screen|current app|active app|front app|current window|active window|where am i)\b/i.test(text);
}

function fallbackPlan(transcript) {
  const command = stripWakeWord(transcript);
  const lower = command.toLowerCase();
  const actions = [];
  let intent = "unknown";
  let summary = "I could not map this voice command to a safe local action.";
  let confidence = 0.35;

  const browserSearch = browserSearchFlowFrom(command);
  if (browserSearch) {
    intent = "browser_search_new_tab";
    summary = `Open a new browser tab and search for ${browserSearch.query}.`;
    confidence = 0.86;
    actions.push({ type: "hotkey", stroke: "t", modifiers: ["command"] });
    actions.push({ type: "type_text", text: browserSearch.query });
    actions.push({ type: "press_key", stroke: "enter" });
  }

  const sequenceParts = !actions.length ? sequentialPartsFrom(command) : [];
  if (sequenceParts.length > 1) {
    const plans = sequenceParts.map((part) => fallbackPlan(part));
    const failedIndex = plans.findIndex((plan) => !plan.actions.length || plan.intent === "unknown");
    if (failedIndex === -1) {
      const combinedActions = plans.flatMap((plan) => plan.actions).slice(0, ACTION_LIMIT);
      const truncated = plans.reduce((total, plan) => total + plan.actions.length, 0) > ACTION_LIMIT;
      return {
        id: commandId("plan"),
        createdAt: now(),
        source: "deterministic",
        wakeWordDetected: command !== cleanText(transcript),
        transcript: cleanText(transcript),
        command,
        intent: "multi_step",
        summary: plans.map((plan) => plan.summary).join(" Then "),
        confidence: Math.min(...plans.map((plan) => plan.confidence)),
        actions: combinedActions,
        warnings: [
          ...plans.flatMap((plan) => plan.warnings || []),
          ...(truncated ? [`Voice sequence was limited to ${ACTION_LIMIT} actions.`] : [])
        ]
      };
    }
    return {
      id: commandId("plan"),
      createdAt: now(),
      source: "deterministic",
      wakeWordDetected: command !== cleanText(transcript),
      transcript: cleanText(transcript),
      command,
      intent,
      summary,
      confidence,
      actions,
      warnings: [`Step ${failedIndex + 1} needs a clearer app, URL, file, click target, or typed text target.`]
    };
  }

  if (!actions.length) {
    const windowControl = windowControlFrom(command);
    if (windowControl) {
      intent = "window_control";
      summary = `Control the desktop window: ${windowControl.label}.`;
      confidence = 0.8;
      actions.push({ type: "window_control", operation: windowControl.operation, ...(windowControl.app ? { app: windowControl.app } : {}) });
    }
  }

  if (!actions.length && wantsDesktopContext(command)) {
    intent = "inspect_context";
    summary = "Inspect the active app, front window, and visible UI labels.";
    confidence = 0.86;
    actions.push({ type: "inspect_context" });
  }

  const workflowId = workflowIdFrom(command);
  if (!actions.length && workflowId) {
    intent = "run_workflow";
    summary = `Run workflow ${workflowId}.`;
    confidence = 0.82;
    actions.push({ type: "run_workflow", workflowId });
  }

  if (!actions.length) {
    const moduleRun = moduleRunFrom(command);
    if (moduleRun?.moduleId && moduleRun.message) {
      intent = "run_module";
      summary = `Send task to ${moduleRun.moduleId}.`;
      confidence = 0.78;
      actions.push({ type: "run_module", moduleId: moduleRun.moduleId, message: moduleRun.message });
    }
  }

  if (!actions.length) {
    const folder = specialFolderFrom(command);
    if (folder) {
      intent = "open_folder";
      summary = `Open ${folder.name} folder.`;
      confidence = 0.9;
      actions.push({ type: "open_file", path: folder.path });
    }
  }

  if (!actions.length) {
    const url = urlFrom(command);
    if (url) {
      intent = "browse";
      summary = `Open ${url} in the default browser.`;
      confidence = 0.85;
      actions.push({ type: "open_url", url });
    } else {
      const search = searchQueryFrom(command);
      if (search) {
        intent = "web_search";
        summary = `Search the web for ${search}.`;
        confidence = 0.82;
        actions.push({ type: "web_search", query: search });
      }
    }
  }

  if (!actions.length) {
    const pageSearch = pageSearchFrom(command);
    if (pageSearch) {
      intent = "page_search";
      summary = `Find ${pageSearch} on the current page.`;
      confidence = 0.8;
      actions.push({ type: "hotkey", stroke: "f", modifiers: ["command"] });
      actions.push({ type: "type_text", text: pageSearch });
    }
  }

  if (!actions.length) {
    const paste = pasteTextFrom(command);
    if (paste && /\b(paste|put)\b/i.test(command)) {
      intent = "paste_text";
      summary = "Paste dictated text into the active app.";
      confidence = 0.82;
      actions.push({ type: "paste_text", text: paste });
    }
  }

  if (!actions.length) {
    const hotkey = hotkeyFrom(command);
    if (hotkey) {
      intent = "hotkey";
      summary = `Use ${hotkey.label || hotkey.key} in the active app.`;
      confidence = 0.78;
      actions.push({ type: "hotkey", stroke: hotkey.key, modifiers: hotkey.modifiers || [] });
    }
  }

  if (!actions.length) {
    const scroll = scrollFrom(command);
    if (scroll) {
      intent = "scroll";
      summary = `Scroll ${scroll.direction}.`;
      confidence = 0.74;
      actions.push({ type: "scroll", direction: scroll.direction, amount: scroll.amount });
    }
  }

  if (!actions.length && /\b(open|launch|start|switch to|activate)\b/i.test(command)) {
    const app = appNameFrom(command);
    if (app && !/\b(file|folder|document|download)\b/i.test(lower)) {
      intent = "open_app";
      summary = `Open ${app}.`;
      confidence = 0.86;
      actions.push({ type: "open_app", app });
    }
  }

  if (!actions.length && /\b(type|write|enter)\b/i.test(command)) {
    const text = typedTextFrom(command);
    if (text) {
      intent = "type_text";
      summary = "Type dictated text into the active app.";
      confidence = 0.78;
      actions.push({ type: "type_text", text });
    }
  }

  if (!actions.length && /\b(screenshot|screen shot|capture screen)\b/i.test(command)) {
    intent = "screenshot";
    summary = "Capture a screenshot to the Hermes Agent OS export folder.";
    confidence = 0.9;
    actions.push({ type: "screenshot" });
  }

  if (!actions.length && /\b(click)\b/i.test(command)) {
    const coords = command.match(/(?:at|on)?\s*(\d{1,5})\s*[,x]\s*(\d{1,5})/i);
    if (coords) {
      intent = "click";
      summary = `Click at ${coords[1]}, ${coords[2]}.`;
      confidence = 0.72;
      actions.push({ type: "click", x: Number(coords[1]), y: Number(coords[2]) });
    }
  }

  if (!actions.length && /\b(click|press|choose|select)\b/i.test(command)) {
    const label = clickTextFrom(command);
    if (label) {
      intent = "click_text";
      summary = `Click UI item matching ${label}.`;
      confidence = 0.58;
      actions.push({ type: "click_text", label });
    }
  }

  if (!actions.length) {
    const folder = createFolderFrom(command);
    if (folder) {
      intent = "create_folder";
      summary = `Create folder ${folder.name}.`;
      confidence = 0.82;
      actions.push({ type: "create_folder", path: folder.path });
    }
  }

  if (!actions.length && wantsTrashSelection(command)) {
    intent = "trash_selection";
    summary = "Move the current Finder selection to Trash.";
    confidence = 0.72;
    actions.push({ type: "trash_selection" });
  }

  if (!actions.length && /\b(find|search for|locate|show me)\b/i.test(command) && /\b(file|folder|document|download)\b/i.test(command)) {
    const query = fileQueryFrom(command);
    if (query) {
      intent = "find_files";
      summary = `Find local files matching ${query}.`;
      confidence = 0.76;
      actions.push({ type: "find_files", query });
    }
  }

  if (!actions.length && /\b(open|show|reveal)\b/i.test(command) && /\b(file|folder|document|download)\b/i.test(command)) {
    const target = openFileTargetFrom(command);
    if (target) {
      intent = "open_file";
      summary = `Find and open a local file or folder matching ${target}.`;
      confidence = 0.72;
      actions.push({ type: "find_files", query: target, openFirst: true });
    }
  }

  if (!actions.length && /\b(ask|tell|use|run)\s+codex\b/i.test(command)) {
    const message = command.replace(/^.*?\bcodex\b/i, "").trim() || command;
    intent = "codex_task";
    summary = "Prepare a Codex CLI task from the voice command.";
    confidence = 0.7;
    actions.push({ type: "codex_task", message });
  }

  return {
    id: commandId("plan"),
    createdAt: now(),
    source: "deterministic",
    wakeWordDetected: command !== cleanText(transcript),
    transcript: cleanText(transcript),
    command,
    intent,
    summary,
    confidence,
    actions,
    warnings: actions.length ? [] : ["Command needs a clearer app, URL, file, click coordinate, or typed text target."]
  };
}

function safeJsonFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) {
      try {
        return JSON.parse(fenced);
      } catch {
        return null;
      }
    }
    const block = raw.match(/\{[\s\S]*\}/)?.[0];
    if (block) {
      try {
        return JSON.parse(block);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function normalizeModelPlan(candidate, transcript) {
  const fallback = fallbackPlan(transcript);
  if (!candidate || typeof candidate !== "object") return fallback;
  const actions = Array.isArray(candidate.actions)
    ? candidate.actions
        .slice(0, ACTION_LIMIT)
        .map((action) => action && typeof action === "object" ? normalizeVoiceAction(action) : null)
        .filter(Boolean)
    : fallback.actions;
  return {
    ...fallback,
    source: "codex-gpt",
    intent: cleanText(candidate.intent || fallback.intent, 80),
    summary: cleanText(candidate.summary || fallback.summary, 500),
    confidence: Math.max(0, Math.min(1, Number(candidate.confidence ?? fallback.confidence))),
    actions,
    warnings: Array.isArray(candidate.warnings) ? candidate.warnings.map((item) => cleanText(item, 240)).filter(Boolean) : fallback.warnings
  };
}

function normalizeVoiceAction(action) {
  const normalized = { ...action };
  const type = cleanText(normalized.type, 80);
  if ((type === "press_key" || type === "hotkey") && !normalized.stroke && (normalized.key || normalized.keys)) {
    normalized.stroke = normalized.key || normalized.keys;
  }
  if (type === "press_key" || type === "hotkey") {
    delete normalized.key;
    delete normalized.keys;
  }
  return normalized;
}

async function getOpenAiKey(stored) {
  return getConfiguredValue(stored, MODULE_ID, "OPENAI_API_KEY") ||
    getConfiguredValue(stored, "provider-openai", "OPENAI_API_KEY") ||
    getConfiguredValue(stored, "codex", "OPENAI_API_KEY") ||
    process.env.OPENAI_API_KEY ||
    "";
}

async function planWithCodexGpt(transcript, stored) {
  const apiKey = await getOpenAiKey(stored);
  if (!apiKey) return null;
  const prompt = [
    "You are the Codex GPT planner inside Hermes Voice Control on macOS.",
    "Return only JSON. Do not include markdown.",
    "Convert the user transcript into a short safe action plan.",
    "Allowed action types: inspect_context, open_app, open_url, web_search, type_text, paste_text, hotkey, press_key, click, click_text, scroll, screenshot, find_files, open_file, create_folder, trash_selection, window_control, run_workflow, run_module, codex_task, shell_command.",
    "For hotkey actions, use {\"type\":\"hotkey\",\"stroke\":\"f\",\"modifiers\":[\"command\"]}; do not use a field named key for keyboard strokes.",
    "For single key press actions, use {\"type\":\"press_key\",\"stroke\":\"enter\"}; do not use a field named key.",
    "For window controls, use {\"type\":\"window_control\",\"operation\":\"minimize_window\"}; supported operations: minimize_window, maximize_window, toggle_full_screen, hide_app, quit_app, show_desktop.",
    "For file creation, use {\"type\":\"create_folder\",\"path\":\"~/Desktop/Folder Name\"}. For trashing, only use {\"type\":\"trash_selection\"} for selected Finder items.",
    "Prefer deterministic desktop actions over shell_command. Use shell_command only for harmless read-only commands.",
    "Schema: {\"intent\":\"...\",\"summary\":\"...\",\"confidence\":0.0,\"actions\":[{\"type\":\"open_app\",\"app\":\"Chrome\"}],\"warnings\":[]}.",
    `Transcript: ${cleanText(transcript)}`
  ].join("\n");
  const response = await fetch(voiceOpenAiUrl(stored), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: voiceModel(stored),
      messages: [
        { role: "system", content: "You produce compact JSON plans for local computer-control actions." },
        { role: "user", content: prompt }
      ],
      temperature: 0.1
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `OpenAI planner returned HTTP ${response.status}`);
  }
  const content = body?.choices?.[0]?.message?.content || "";
  return normalizeModelPlan(safeJsonFromText(content), transcript);
}

async function buildPlan(transcript, input = {}, stored = null) {
  const base = fallbackPlan(transcript);
  const currentStored = stored || await getStoredConnectionConfig();
  const openAiKey = await getOpenAiKey(currentStored);
  const modelAllowed = input.useModel !== false &&
    !voicePlannerDisabled(currentStored) &&
    Boolean(openAiKey);
  if (!modelAllowed) return base;
  try {
    return await planWithCodexGpt(transcript, currentStored);
  } catch (error) {
    return {
      ...base,
      warnings: [...base.warnings, `Codex GPT planner fallback: ${redactText(error?.message || "planning failed")}`]
    };
  }
}

async function toolStatus() {
  const [osascript, openTool, screencapture, mdfind, cliclick, codex] = await Promise.all([
    which("osascript"),
    which("open"),
    which("screencapture"),
    which("mdfind"),
    which("cliclick"),
    which("codex")
  ]);
  const stored = await getStoredConnectionConfig();
  const openAiKey = await getOpenAiKey(stored);
  const executionGate = await getExecutionGateStatus();
  const desktop = await getDesktopContext({ includeUiElements: false, timeoutMs: 3000 }).catch((error) => ({
    ok: false,
    accessibility: false,
    error: redactText(error?.message || "desktop context unavailable")
  }));
  return {
    osascript: Boolean(osascript),
    open: Boolean(openTool),
    screencapture: Boolean(screencapture),
    mdfind: Boolean(mdfind),
    cliclick: Boolean(cliclick),
    codex: Boolean(codex),
    codexGptPlanner: Boolean(openAiKey),
    executionGate: executionGate.enabled,
    executionGateSource: executionGate.source,
    shellGate: voiceShellAllowed(stored),
    accessibility: Boolean(desktop.accessibility),
    frontApp: desktop.frontApp || null,
    frontWindow: desktop.frontWindow || null,
    model: voiceModel(stored)
  };
}

function assertInsideHome(target) {
  const resolved = path.resolve(expandHome(target));
  if (resolved === "/Applications" || resolved.startsWith("/Applications/")) return resolved;
  const relative = path.relative(os.homedir(), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    const error = new Error("Voice file actions are limited to the current user home folder.");
    error.code = "VOICE_PATH_POLICY";
    throw error;
  }
  return resolved;
}

async function runAppleScript(script, timeoutMs = 8000) {
  const osascript = await which("osascript");
  if (!osascript) return { ok: false, stdout: "", stderr: "osascript is not available", code: 127 };
  return runCommand(osascript, ["-e", script], timeoutMs);
}

function appleModifierList(modifiers = []) {
  const clean = modifiers
    .map((item) => cleanText(item, 40).toLowerCase())
    .filter((item) => ["command", "shift", "option", "control"].includes(item))
    .map((item) => `${item} down`);
  if (!clean.length) return "";
  return clean.length === 1 ? ` using ${clean[0]}` : ` using {${clean.join(", ")}}`;
}

function keyStrokeScript(key, modifiers = []) {
  const normalized = cleanText(key, 40).toLowerCase().replace(/\s+/g, "");
  const alias = KEY_ALIASES[normalized];
  const suffix = appleModifierList(modifiers);
  if (alias?.keyCode) return `tell application "System Events" to key code ${alias.keyCode}${suffix}`;
  return `tell application "System Events" to keystroke ${JSON.stringify(cleanText(key, 10) || " ")}${suffix}`;
}

function windowControlScript(operation, app = "") {
  const targetApp = cleanText(app, 120);
  const frontProcessLine = targetApp
    ? `set targetApp to application process ${JSON.stringify(targetApp)}`
    : "set targetApp to first application process whose frontmost is true";
  const activateLine = targetApp ? `tell application ${JSON.stringify(targetApp)} to activate` : "";
  if (operation === "toggle_full_screen") {
    return [activateLine, keyStrokeScript("f", ["control", "command"])].filter(Boolean).join("\n");
  }
  if (operation === "hide_app" && targetApp) {
    return [
      "tell application \"System Events\"",
      `set visible of application process ${JSON.stringify(targetApp)} to false`,
      "end tell"
    ].join("\n");
  }
  if (operation === "hide_app") return keyStrokeScript("h", ["command"]);
  if (operation === "quit_app" && targetApp) return `tell application ${JSON.stringify(targetApp)} to quit`;
  if (operation === "quit_app") return keyStrokeScript("q", ["command"]);
  if (operation === "show_desktop") return "tell application \"System Events\" to key code 103";
  if (operation === "minimize_window") {
    return [
      activateLine,
      "tell application \"System Events\"",
      frontProcessLine,
      "if not (exists window 1 of targetApp) then error \"No front window is available.\"",
      "try",
      "set value of attribute \"AXMinimized\" of window 1 of targetApp to true",
      "on error",
      "click (first button of window 1 of targetApp whose subrole is \"AXMinimizeButton\")",
      "end try",
      "end tell"
    ].filter(Boolean).join("\n");
  }
  if (operation === "maximize_window") {
    return [
      activateLine,
      "tell application \"System Events\"",
      frontProcessLine,
      "if not (exists window 1 of targetApp) then error \"No front window is available.\"",
      "try",
      "perform action \"AXZoomWindow\" of window 1 of targetApp",
      "on error",
      "click (first button of window 1 of targetApp whose subrole is \"AXZoomButton\")",
      "end try",
      "end tell"
    ].filter(Boolean).join("\n");
  }
  return "";
}

async function setClipboardText(text) {
  return runAppleScript(`set the clipboard to ${JSON.stringify(text)}`, 8000);
}

function parseAppleScriptContext(stdout) {
  const text = String(stdout || "");
  const lines = text.split(/\r?\n/);
  const fields = {};
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    fields[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  const uiLabels = fields.uiLabels
    ? fields.uiLabels.split("||").map((item) => cleanText(item, 160)).filter(Boolean).slice(0, 60)
    : [];
  return {
    frontApp: fields.frontApp || null,
    frontWindow: fields.frontWindow || null,
    windowCount: Number(fields.windowCount || 0),
    uiElementCount: Number(fields.uiElementCount || 0),
    uiLabels
  };
}

export async function getDesktopContext({ includeUiElements = true, timeoutMs = 8000 } = {}) {
  const uiScript = includeUiElements
    ? [
        "set labelTexts to {}",
        "try",
        "set uiMatches to every UI element of entire contents of frontApp whose name is not missing value",
        "repeat with itemRef in uiMatches",
        "try",
        "set itemName to name of itemRef as text",
        "if itemName is not \"\" and labelTexts does not contain itemName then set end of labelTexts to itemName",
        "end try",
        "if (count of labelTexts) is greater than 60 then exit repeat",
        "end repeat",
        "set uiCount to count of uiMatches",
        "end try",
        "set AppleScript's text item delimiters to \"||\"",
        "set uiText to labelTexts as text",
        "set AppleScript's text item delimiters to \"\""
      ].join("\n")
    : "set uiText to \"\"\nset uiCount to 0";
  const script = [
    "tell application \"System Events\"",
    "set frontApp to first application process whose frontmost is true",
    "set appName to name of frontApp",
    "set windowTitle to \"\"",
    "set windowCount to 0",
    "try",
    "set windowCount to count of windows of frontApp",
    "if windowCount is greater than 0 then set windowTitle to name of window 1 of frontApp",
    "end try",
    "set uiCount to 0",
    uiScript,
    "return \"frontApp:\" & appName & linefeed & \"frontWindow:\" & windowTitle & linefeed & \"windowCount:\" & windowCount & linefeed & \"uiElementCount:\" & uiCount & linefeed & \"uiLabels:\" & uiText",
    "end tell"
  ].join("\n");
  const executed = await runAppleScript(script, timeoutMs);
  if (!executed.ok) {
    return sanitizeObject({
      ok: false,
      accessibility: false,
      frontApp: null,
      frontWindow: null,
      windowCount: 0,
      uiElementCount: 0,
      uiLabels: [],
      error: redactText(executed.stderr || executed.stdout || "Desktop context inspection failed. Grant Accessibility permission to the runtime.")
    });
  }
  return sanitizeObject({
    ok: true,
    accessibility: true,
    ...parseAppleScriptContext(executed.stdout),
    error: null
  });
}

async function executeAction(action, context) {
  const type = cleanText(action?.type, 80);
  const dryRun = context.dryRun;
  const result = {
    type,
    ok: true,
    dryRun,
    summary: "",
    output: null,
    command: null,
    error: null
  };

  if (type === "inspect_context") {
    result.summary = "Inspect active desktop context.";
    result.command = "osascript System Events front app/window/UI labels";
    const desktop = await getDesktopContext({ includeUiElements: true, timeoutMs: 10000 });
    result.ok = Boolean(desktop.ok);
    result.output = desktop;
    result.error = desktop.ok ? null : desktop.error || "desktop context unavailable";
    return result;
  }

  if (type === "open_app") {
    const app = cleanText(action.app || action.name, 100);
    result.summary = `Open app: ${app}`;
    result.command = `osascript activate ${app}`;
    if (!app) throw new Error("open_app requires app");
    if (!dryRun) {
      const executed = await runAppleScript(`tell application ${JSON.stringify(app)} to activate`);
      result.ok = executed.ok;
      result.output = redactText(executed.stdout || executed.stderr);
      result.error = executed.ok ? null : redactText(executed.stderr || "failed to open app");
    }
    return result;
  }

  if (type === "open_url" || type === "web_search") {
    const url = type === "web_search"
      ? `https://www.google.com/search?q=${encodeURIComponent(cleanText(action.query, 400))}`
      : cleanText(action.url, 1000);
    result.summary = type === "web_search" ? `Search web: ${action.query || ""}` : `Open URL: ${url}`;
    result.command = `open ${url}`;
    if (!isHttpUrl(url)) throw new Error(`${type} requires an http URL`);
    if (!dryRun) {
      const openTool = await which("open");
      const executed = openTool ? await runCommand(openTool, [url], 8000) : { ok: false, stderr: "open is not available" };
      result.ok = executed.ok;
      result.output = redactText(executed.stdout || executed.stderr);
      result.error = executed.ok ? null : redactText(executed.stderr || "failed to open URL");
    }
    return result;
  }

  if (type === "type_text") {
    const text = cleanText(action.text, 2000);
    result.summary = `Type ${text.length} characters into the active app.`;
    result.command = "osascript System Events keystroke <text>";
    if (!text) throw new Error("type_text requires text");
    if (!dryRun) {
      const script = `tell application "System Events" to keystroke ${JSON.stringify(text)}`;
      const executed = await runAppleScript(script, 12000);
      result.ok = executed.ok;
      result.output = redactText(executed.stdout || executed.stderr);
      result.error = executed.ok ? null : redactText(executed.stderr || "typing failed; grant Accessibility permission to the terminal/runtime");
    }
    return result;
  }

  if (type === "paste_text") {
    const text = cleanText(action.text, 4000);
    result.summary = `Paste ${text.length} characters into the active app.`;
    result.command = "clipboard set + command-v";
    if (!text) throw new Error("paste_text requires text");
    if (!dryRun) {
      const copied = await setClipboardText(text);
      if (!copied.ok) {
        result.ok = false;
        result.output = redactText(copied.stdout || copied.stderr);
        result.error = redactText(copied.stderr || "clipboard update failed");
        return result;
      }
      const pasted = await runAppleScript(keyStrokeScript("v", ["command"]), 8000);
      result.ok = pasted.ok;
      result.output = redactText(pasted.stdout || pasted.stderr);
      result.error = pasted.ok ? null : redactText(pasted.stderr || "paste failed; grant Accessibility permission to the terminal/runtime");
    }
    return result;
  }

  if (type === "hotkey") {
    const key = cleanText(action.stroke || action.key || action.keys, 80);
    const modifiers = Array.isArray(action.modifiers) ? action.modifiers : [];
    result.summary = `Press hotkey: ${[...modifiers, key].join("+")}.`;
    result.command = `osascript System Events hotkey ${[...modifiers, key].join("+")}`;
    if (!key) throw new Error("hotkey requires key");
    if (!dryRun) {
      const executed = await runAppleScript(keyStrokeScript(key, modifiers), 8000);
      result.ok = executed.ok;
      result.output = redactText(executed.stdout || executed.stderr);
      result.error = executed.ok ? null : redactText(executed.stderr || "hotkey failed; grant Accessibility permission to the terminal/runtime");
    }
    return result;
  }

  if (type === "press_key") {
    const key = cleanText(action.stroke || action.key || action.keys, 80);
    result.summary = `Press key: ${key}`;
    result.command = `osascript System Events keystroke ${key}`;
    if (!key) throw new Error("press_key requires key");
    if (!dryRun) {
      const executed = await runAppleScript(keyStrokeScript(key), 8000);
      result.ok = executed.ok;
      result.output = redactText(executed.stdout || executed.stderr);
      result.error = executed.ok ? null : redactText(executed.stderr || "key press failed");
    }
    return result;
  }

  if (type === "window_control") {
    const operation = cleanText(action.operation, 80).toLowerCase();
    const app = cleanText(action.app || action.name, 120);
    const allowed = new Set(["minimize_window", "maximize_window", "toggle_full_screen", "hide_app", "quit_app", "show_desktop"]);
    result.summary = `Control window: ${operation.replaceAll("_", " ")}${app ? ` for ${app}` : ""}.`;
    result.command = `osascript System Events window_control ${operation}${app ? ` ${app}` : ""}`;
    if (!allowed.has(operation)) throw new Error("window_control requires a supported operation");
    if (!dryRun) {
      const executed = await runAppleScript(windowControlScript(operation, app), 12000);
      result.ok = executed.ok;
      result.output = redactText(executed.stdout || executed.stderr);
      result.error = executed.ok ? null : redactText(executed.stderr || "window control failed; grant Accessibility permission to the terminal/runtime");
    }
    return result;
  }

  if (type === "click_text") {
    const label = cleanText(action.label || action.text || action.name, 120);
    result.summary = `Click visible UI item matching: ${label}`;
    result.command = `osascript click UI element named ${label}`;
    if (!label) throw new Error("click_text requires label");
    if (!dryRun) {
      const script = [
        "tell application \"System Events\"",
        "set frontApp to first application process whose frontmost is true",
        `set wanted to ${JSON.stringify(label)}`,
        "set matches to {}",
        "try",
        "set matches to (every UI element of entire contents of frontApp whose name contains wanted)",
        "end try",
        "if (count of matches) is 0 then error \"No visible UI element matched the requested label.\"",
        "click item 1 of matches",
        "end tell"
      ].join("\n");
      const executed = await runAppleScript(script, 12000);
      result.ok = executed.ok;
      result.output = redactText(executed.stdout || executed.stderr);
      result.error = executed.ok ? null : redactText(executed.stderr || "click-by-label failed; grant Accessibility permission and verify the label is visible");
    }
    return result;
  }

  if (type === "scroll") {
    const direction = cleanText(action.direction, 20).toLowerCase();
    const amount = Math.max(1, Math.min(20, Number(action.amount || 6)));
    const wheel = direction === "up" ? amount : direction === "down" ? -amount : 0;
    const horizontal = direction === "left" ? amount : direction === "right" ? -amount : 0;
    result.summary = `Scroll ${direction || "down"}.`;
    result.command = `cliclick w:${horizontal},${wheel}`;
    if (!["up", "down", "left", "right"].includes(direction)) throw new Error("scroll requires direction");
    if (!dryRun) {
      const cliclick = await which("cliclick");
      if (!cliclick) {
        result.ok = false;
        result.error = "cliclick is required for scroll actions.";
        result.output = result.error;
      } else {
        const executed = await runCommand(cliclick, [`w:${horizontal},${wheel}`], 8000);
        result.ok = executed.ok;
        result.output = redactText(executed.stdout || executed.stderr);
        result.error = executed.ok ? null : redactText(executed.stderr || "scroll failed");
      }
    }
    return result;
  }

  if (type === "click") {
    const x = Number(action.x);
    const y = Number(action.y);
    result.summary = `Click at ${x}, ${y}.`;
    result.command = `cliclick c:${x},${y}`;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("click requires numeric x and y");
    if (!dryRun) {
      const cliclick = await which("cliclick");
      if (!cliclick) {
        result.ok = false;
        result.error = "cliclick is required for coordinate clicks.";
        result.output = result.error;
      } else {
        const executed = await runCommand(cliclick, [`c:${Math.round(x)},${Math.round(y)}`], 8000);
        result.ok = executed.ok;
        result.output = redactText(executed.stdout || executed.stderr);
        result.error = executed.ok ? null : redactText(executed.stderr || "click failed");
      }
    }
    return result;
  }

  if (type === "screenshot") {
    const dir = path.join(runtimePaths().exports, "voice-control", "screenshots");
    const file = path.join(dir, `screenshot-${Date.now()}.png`);
    result.summary = "Capture screenshot.";
    result.command = `screencapture ${file}`;
    if (!dryRun) {
      await fs.mkdir(dir, { recursive: true });
      const screencapture = await which("screencapture");
      const executed = screencapture ? await runCommand(screencapture, ["-x", file], 12000) : { ok: false, stderr: "screencapture is not available" };
      result.ok = executed.ok;
      result.output = executed.ok ? { file: redactText(file) } : redactText(executed.stderr || "screenshot failed");
      result.error = executed.ok ? null : redactText(executed.stderr || "screenshot failed");
    }
    return result;
  }

  if (type === "find_files") {
    const query = cleanText(action.query, 200);
    result.summary = `Find files matching ${query}.`;
    result.command = `mdfind -onlyin ~ ${query}`;
    if (!query) throw new Error("find_files requires query");
    if (!dryRun) {
      const mdfind = await which("mdfind");
      const args = ["-onlyin", os.homedir(), `kMDItemFSName == '*${query.replaceAll("'", "")}*'c`];
      const executed = mdfind ? await runCommand(mdfind, args, 10000) : await runCommand("/usr/bin/find", [os.homedir(), "-iname", `*${query}*`, "-maxdepth", "6"], 12000);
      const files = String(executed.stdout || "").split("\n").map((item) => item.trim()).filter(Boolean).slice(0, 20);
      result.ok = executed.ok;
      result.output = files.map((item) => redactText(item));
      result.error = executed.ok ? null : redactText(executed.stderr || "file search failed");
      if (executed.ok && action.openFirst && files[0]) {
        const openTool = await which("open");
        if (openTool) await runCommand(openTool, [files[0]], 8000);
      }
    }
    return result;
  }

  if (type === "open_file") {
    const target = assertInsideHome(action.path || action.file || action.target || "");
    result.summary = `Open file or folder: ${redactText(target)}`;
    result.command = `open ${redactText(target)}`;
    if (!dryRun) {
      const openTool = await which("open");
      const executed = openTool ? await runCommand(openTool, [target], 8000) : { ok: false, stderr: "open is not available" };
      result.ok = executed.ok;
      result.output = redactText(executed.stdout || executed.stderr);
      result.error = executed.ok ? null : redactText(executed.stderr || "open file failed");
    }
    return result;
  }

  if (type === "create_folder") {
    const target = assertInsideHome(action.path || action.folder || action.target || "");
    result.summary = `Create folder: ${redactText(target)}`;
    result.command = `mkdir ${redactText(target)}`;
    if (!dryRun) {
      try {
        await fs.mkdir(target, { recursive: false });
        result.output = { path: redactText(target) };
      } catch (error) {
        result.ok = false;
        result.output = redactText(error?.message || "folder creation failed");
        result.error = result.output;
      }
    }
    return result;
  }

  if (type === "trash_selection") {
    result.summary = "Move selected Finder items to Trash.";
    result.command = "osascript Finder delete selection";
    if (!dryRun) {
      const script = [
        "tell application \"Finder\"",
        "set selectedItems to selection",
        "if (count of selectedItems) is 0 then error \"No Finder items are selected.\"",
        "delete selectedItems",
        "end tell"
      ].join("\n");
      const executed = await runAppleScript(script, 12000);
      result.ok = executed.ok;
      result.output = redactText(executed.stdout || executed.stderr);
      result.error = executed.ok ? null : redactText(executed.stderr || "trash selected items failed");
    }
    return result;
  }

  if (type === "run_workflow") {
    const workflowId = cleanText(action.workflowId || action.id || action.name, 160).replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
    result.summary = `Run Agent OS workflow: ${workflowId}`;
    result.command = `workflow run ${workflowId}`;
    if (!workflowId) throw new Error("run_workflow requires workflowId");
    if (!dryRun) {
      if (typeof context.runWorkflow !== "function") {
        result.ok = false;
        result.error = "Workflow runner is not available in this voice command context.";
        result.output = result.error;
      } else {
        const workflow = await context.runWorkflow(workflowId, { trigger: "voice-control", transcript: context.transcript || "" });
        result.ok = !["error", "failed"].includes(String(workflow?.status || "").toLowerCase());
        result.output = sanitizeObject({
          id: workflow?.id,
          workflowId: workflow?.workflowId,
          status: workflow?.status,
          nodeRuns: Array.isArray(workflow?.nodeRuns) ? workflow.nodeRuns.length : 0,
          events: Array.isArray(workflow?.events) ? workflow.events.length : 0
        });
        result.error = result.ok ? null : `workflow finished with ${workflow?.status || "unknown status"}`;
      }
    }
    return result;
  }

  if (type === "run_module") {
    const moduleId = cleanText(action.moduleId || action.id, 120).replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
    const message = cleanText(action.message || action.prompt, 4000);
    result.summary = `Send voice task to module: ${moduleId}`;
    result.command = `module run ${moduleId}`;
    if (!moduleId || !message) throw new Error("run_module requires moduleId and message");
    if (!dryRun) {
      if (typeof context.runModule !== "function") {
        result.ok = false;
        result.error = "Module runner is not available in this voice command context.";
        result.output = result.error;
      } else {
        const moduleResult = await context.runModule(moduleId, {
          message,
          prompt: message,
          dryRun: action.dryRun === false ? false : undefined,
          source: "voice-control",
          sourceTranscript: context.transcript || ""
        });
        result.ok = Boolean(moduleResult?.ok);
        result.output = sanitizeObject({
          mode: moduleResult?.mode,
          reply: moduleResult?.reply,
          provider: moduleResult?.provider,
          proof: moduleResult?.proof
        });
        result.error = result.ok ? null : cleanText(moduleResult?.reply || "module run failed", 500);
      }
    }
    return result;
  }

  if (type === "codex_task") {
    const message = cleanText(action.message || action.prompt, 4000);
    result.summary = "Run a Codex CLI task.";
    result.command = "codex <prompt>";
    if (!message) throw new Error("codex_task requires message");
    if (!dryRun) {
      const codex = await which("codex");
      if (!codex) {
        result.ok = false;
        result.error = "Codex CLI is not installed or not on PATH.";
        result.output = result.error;
      } else {
        const executed = await runCommand(codex, [message], context.codexTimeoutMs || 300000);
        result.ok = executed.ok;
        result.output = redactText(executed.stdout || executed.stderr);
        result.error = executed.ok ? null : redactText(executed.stderr || "codex task failed");
      }
    }
    return result;
  }

  if (type === "shell_command") {
    const command = cleanText(action.command, 1000);
    result.summary = "Run a gated shell command.";
    result.command = command.replace(/\s+/g, " ");
    if (!command) throw new Error("shell_command requires command");
    if (!context.shellAllowed) {
      result.ok = false;
      result.error = "Set HERMES_VOICE_ALLOW_SHELL=1 to allow voice-triggered shell commands.";
      result.output = result.error;
      return result;
    }
    if (!dryRun) {
      const executed = await runCommand("/bin/zsh", ["-lc", command], Number(action.timeoutMs || 15000));
      result.ok = executed.ok;
      result.output = redactText(executed.stdout || executed.stderr);
      result.error = executed.ok ? null : redactText(executed.stderr || "shell command failed");
    }
    return result;
  }

  result.ok = false;
  result.error = `Unsupported voice action: ${type || "unknown"}`;
  result.output = result.error;
  return result;
}

export async function getVoiceControlStatus() {
  const tools = await toolStatus();
  const missing = [];
  if (!tools.open) missing.push("open");
  if (!tools.osascript) missing.push("osascript");
  return sanitizeObject({
    id: MODULE_ID,
    label: "Hermes Voice Control",
    status: missing.length ? "missing_dependency" : "connected",
    configured: missing.length === 0,
    missing,
    model: tools.model,
    wakeWords: WAKE_WORDS,
    tools,
    capabilities: [
      "wake-word-transcripts",
      "codex-gpt-planning",
      "desktop-control",
      "desktop-context",
      "accessibility-diagnostics",
      "open-apps",
      "browse",
      "file-search",
      "file-create",
      "file-trash-selected",
      "click",
      "click-by-label",
      "type",
      "paste",
      "hotkeys",
      "window-control",
      "scroll",
      "screenshots",
      "workflow-runs",
      "module-handoffs",
      "codex-cli-task-handoff",
      "gated-shell"
    ],
    publicSummary: tools.codexGptPlanner
      ? "Voice commands can be planned with Codex GPT and executed through gated local macOS/browser/file tools."
      : "Voice commands use deterministic local planning until OPENAI_API_KEY is configured for Codex GPT planning."
  });
}

export async function runVoiceCommand(input = {}, handlers = {}) {
  const transcript = cleanText(input.transcript || input.message || input.prompt, 4000);
  if (!transcript) {
    const error = new Error("transcript, message, or prompt is required");
    error.status = 400;
    throw error;
  }
  const execEnabled = await isExecutionEnabled();
  const explicitExecution = input.dryRun === false;
  const dryRun = !(execEnabled && explicitExecution);
  const stored = await getStoredConnectionConfig();
  const plan = await buildPlan(transcript, input, stored);
  const tools = await toolStatus();
  const context = {
    dryRun,
    shellAllowed: voiceShellAllowed(stored),
    codexTimeoutMs: voiceCodexTimeoutMs(stored),
    transcript,
    runWorkflow: handlers.runWorkflow,
    runModule: handlers.runModule
  };
  const startedAt = now();
  const actionResults = [];
  for (const action of plan.actions.slice(0, ACTION_LIMIT)) {
    try {
      actionResults.push(await executeAction(action, context));
    } catch (error) {
      actionResults.push({
        type: cleanText(action?.type, 80) || "unknown",
        ok: false,
        dryRun,
        summary: "Action failed validation or execution.",
        output: null,
        command: null,
        error: redactText(error?.message || "action failed")
      });
    }
  }
  const ok = actionResults.length > 0 && actionResults.every((item) => item.ok);
  const runId = commandId("voice_run");
  const reply = dryRun
    ? `${plan.summary} Execution is prepared only; enable trusted live execution and send dryRun:false to control the computer.`
    : ok
      ? `${plan.summary} Done.`
      : `${plan.summary} Some actions need attention.`;
  const result = sanitizeObject({
    ok,
    runId,
    mode: dryRun ? "dry_run" : "executed",
    reply,
    startedAt,
    completedAt: now(),
    transcript,
    command: plan.command,
    plan,
    actions: actionResults,
    tools,
    proof: {
      runId,
      moduleId: MODULE_ID,
      moduleLabel: "Hermes Voice Control",
      moduleType: "desktop_voice",
      status: ok ? "completed" : dryRun ? "prepared" : "partial",
      mode: dryRun ? "dry_run" : "executed",
      requestedAt: startedAt,
      dryRun,
      execEnabled,
      explicitExecution,
      promptChars: transcript.length,
      action: plan.intent,
      nextStep: dryRun
        ? "Review the plan, then enable the execution gate and run with dryRun:false from the trusted local dashboard."
        : ok
          ? "Continue with the next voice command."
          : "Review failed action output, permissions, and tool availability.",
      evidence: [
        `planner: ${plan.source}`,
        `actions: ${actionResults.length}`,
        `execution gate: ${execEnabled ? "enabled" : "disabled"}`,
        `explicit execution: ${explicitExecution ? "yes" : "no"}`
      ]
    }
  });
  await appendModuleLog(MODULE_ID, {
    level: ok ? "info" : "warn",
    message: dryRun ? "Voice command planned" : "Voice command executed",
    details: result
  });
  await addMemory({
    type: "episodic",
    namespace: "voice-control",
    agentId: MODULE_ID,
    title: `Voice command: ${plan.intent}`,
    content: `${plan.summary}\nMode: ${result.mode}\nActions: ${actionResults.map((item) => item.summary || item.type).join("; ")}`,
    tags: ["voice-control", plan.intent, result.mode].filter(Boolean),
    privacy: "private",
    metadata: {
      runId,
      planner: plan.source,
      ok,
      dryRun
    }
  }).catch(() => null);
  return result;
}
