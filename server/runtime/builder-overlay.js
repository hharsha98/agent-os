import { getWorkflowRunReplay } from "./workflows.js";

export const BUILDER_REPLAY_OVERLAY_SELECTORS = [
  ".react-flow__node",
  "[data-nodeid]",
  "[data-node-id]",
  "[data-id]",
  "[class*='node']",
  "[role='group']"
];

export function builderReplayOverlayUrl({ workflowId, runId, basePath = "/agent-builder-source/?view=builder" } = {}) {
  const url = new URL(basePath, "http://hermes.local");
  url.searchParams.set("hermesReplay", "1");
  if (workflowId) url.searchParams.set("hermesWorkflowId", String(workflowId));
  if (runId) url.searchParams.set("hermesRunId", String(runId));
  return `${url.pathname}${url.search}`;
}

export async function getBuilderReplayOverlay(workflowId, runId) {
  if (!workflowId || !runId) {
    const error = new Error("workflowId and runId are required for builder replay overlay.");
    error.status = 400;
    throw error;
  }
  const replay = await getWorkflowRunReplay(workflowId, runId);
  if (!replay) {
    const error = new Error("Workflow replay not found.");
    error.status = 404;
    throw error;
  }
  return {
    id: "builder-replay-overlay",
    workflowId: replay.workflowId,
    runId: replay.runId,
    status: replay.status,
    generatedAt: new Date().toISOString(),
    overlayMode: "dom-anchor-with-coordinate-fallback",
    selectors: BUILDER_REPLAY_OVERLAY_SELECTORS,
    summary: replay.summary,
    replay
  };
}

export function builderReplayOverlayScript() {
  return `<script id="hermes-replay-overlay-bootstrap">
(() => {
  if (window.__HERMES_REPLAY_OVERLAY__) return;
  window.__HERMES_REPLAY_OVERLAY__ = true;
  const params = new URLSearchParams(window.location.search);
  if (params.get("hermesReplay") !== "1") return;
  const workflowId = params.get("hermesWorkflowId");
  const runId = params.get("hermesRunId");
  if (!workflowId || !runId) return;

  const selectors = ${JSON.stringify(BUILDER_REPLAY_OVERLAY_SELECTORS)};
  const palette = {
    completed: "#5eeaff",
    running: "#a76cff",
    failed: "#ff5c8a",
    waiting_for_approval: "#ffb84a",
    ready_to_configure: "#ffb84a",
    not_run: "#8b82a8"
  };

  const style = document.createElement("style");
  style.id = "hermes-replay-overlay-style";
  style.textContent = \`
    #hermes-replay-overlay-root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    #hermes-replay-overlay-root .hermes-replay-panel { position: fixed; right: 16px; bottom: 16px; width: min(360px, calc(100vw - 32px)); padding: 12px; border: 1px solid rgba(167,108,255,.42); border-radius: 10px; background: rgba(8,5,18,.9); color: #f8f4ff; box-shadow: 0 20px 80px rgba(0,0,0,.45); backdrop-filter: blur(16px); pointer-events: auto; }
    #hermes-replay-overlay-root .hermes-replay-panel b { display: block; color: #5eeaff; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
    #hermes-replay-overlay-root .hermes-replay-panel p { margin: 6px 0 0; color: #bdb4d8; font-size: 12px; line-height: 1.45; }
    #hermes-replay-overlay-root .hermes-replay-badge { position: fixed; transform: translate(-50%, -50%); min-width: 112px; max-width: 180px; padding: 7px 9px; border: 1px solid currentColor; border-radius: 8px; background: rgba(12, 8, 28, .9); color: #5eeaff; box-shadow: 0 10px 30px rgba(0,0,0,.34); pointer-events: none; }
    #hermes-replay-overlay-root .hermes-replay-badge strong { display: block; overflow: hidden; color: #fff; font-size: 12px; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
    #hermes-replay-overlay-root .hermes-replay-badge span { display: block; margin-top: 3px; overflow: hidden; font: 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
    #hermes-replay-overlay-root .hermes-replay-edge { position: fixed; height: 2px; transform-origin: 0 50%; background: linear-gradient(90deg, rgba(94,234,255,.9), rgba(255,61,178,.75)); opacity: .72; box-shadow: 0 0 16px rgba(94,234,255,.5); }
  \`;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "hermes-replay-overlay-root";
  document.documentElement.appendChild(root);
  let latest = null;

  function normalizeText(value) {
    return String(value || "").trim().toLowerCase().replace(/\\s+/g, " ");
  }

  function candidateElements() {
    const seen = new Set();
    return selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter((element) => {
      if (seen.has(element)) return false;
      seen.add(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 24 && rect.height > 18;
    });
  }

  function findAnchor(node) {
    const targetId = normalizeText(node.id);
    const targetLabel = normalizeText(node.label);
    const candidates = candidateElements();
    let best = null;
    for (const element of candidates) {
      const text = normalizeText(element.textContent);
      const dataId = normalizeText(element.getAttribute("data-id") || element.getAttribute("data-nodeid") || element.getAttribute("data-node-id"));
      const match = dataId === targetId || text.includes(targetLabel) || text.includes(targetId);
      if (!match) continue;
      const rect = element.getBoundingClientRect();
      const score = rect.width * rect.height;
      if (!best || score < best.score) best = { rect, score };
    }
    return best?.rect || null;
  }

  function fallbackRect(node, replay) {
    const nodes = replay.nodes || [];
    const xs = nodes.map((item) => Number(item.position?.x || 0));
    const ys = nodes.map((item) => Number(item.position?.y || 0));
    const minX = Math.min(...xs, 0);
    const minY = Math.min(...ys, 0);
    const maxX = Math.max(...xs, 1);
    const maxY = Math.max(...ys, 1);
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const x = 96 + ((Number(node.position?.x || 0) - minX) / width) * Math.min(window.innerWidth - 240, 900);
    const y = 128 + ((Number(node.position?.y || 0) - minY) / height) * Math.min(window.innerHeight - 260, 520);
    return { left: x, top: y, width: 1, height: 1 };
  }

  function center(rect) {
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function renderEdge(sourceRect, targetRect) {
    const source = center(sourceRect);
    const target = center(targetRect);
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const line = document.createElement("div");
    line.className = "hermes-replay-edge";
    line.style.left = source.x + "px";
    line.style.top = source.y + "px";
    line.style.width = length + "px";
    line.style.transform = "rotate(" + Math.atan2(dy, dx) + "rad)";
    root.appendChild(line);
  }

  function render() {
    if (!latest?.replay) return;
    const replay = latest.replay;
    root.replaceChildren();
    const rectByNode = new Map();
    for (const node of replay.nodes || []) {
      const anchored = findAnchor(node);
      const rect = anchored || fallbackRect(node, replay);
      rectByNode.set(node.id, rect);
      const badge = document.createElement("div");
      badge.className = "hermes-replay-badge";
      badge.style.color = palette[node.status] || palette.not_run;
      badge.style.left = (rect.left + rect.width / 2) + "px";
      badge.style.top = (rect.top - 10) + "px";
      badge.dataset.hermesReplayNodeId = node.id;
      badge.innerHTML = "<strong></strong><span></span>";
      badge.querySelector("strong").textContent = node.label;
      badge.querySelector("span").textContent = node.status + " / attempts " + node.attempts + (anchored ? " / anchored" : " / replay position");
      root.appendChild(badge);
    }
    for (const edge of replay.edges || []) {
      if (edge.status !== "traversed") continue;
      const sourceRect = rectByNode.get(edge.source);
      const targetRect = rectByNode.get(edge.target);
      if (sourceRect && targetRect) renderEdge(sourceRect, targetRect);
    }
    const panel = document.createElement("div");
    panel.className = "hermes-replay-panel";
    panel.innerHTML = "<b></b><p></p>";
    panel.querySelector("b").textContent = "Hermes Replay Overlay";
    panel.querySelector("p").textContent = replay.workflowId + " / " + replay.runId + " / " + replay.status + " / " + replay.summary.traversedEdges + " traversed edges";
    root.appendChild(panel);
  }

  async function refresh() {
    try {
      const response = await fetch("/api/builder/replay-overlay?workflowId=" + encodeURIComponent(workflowId) + "&runId=" + encodeURIComponent(runId), { credentials: "same-origin" });
      if (!response.ok) throw new Error("Overlay fetch failed " + response.status);
      latest = await response.json();
      render();
    } catch (error) {
      root.replaceChildren();
      const panel = document.createElement("div");
      panel.className = "hermes-replay-panel";
      panel.innerHTML = "<b>Hermes Replay Overlay</b><p></p>";
      panel.querySelector("p").textContent = error.message || "Replay unavailable.";
      root.appendChild(panel);
    }
  }

  window.addEventListener("resize", render);
  window.addEventListener("scroll", render, true);
  refresh();
  setInterval(render, 800);
  setInterval(refresh, 5000);
})();
</script>`;
}

export function injectBuilderReplayOverlay(html = "") {
  if (!html || html.includes("hermes-replay-overlay-bootstrap")) return html;
  const script = builderReplayOverlayScript();
  if (html.includes("</body>")) return html.replace("</body>", `${script}</body>`);
  return `${html}${script}`;
}
