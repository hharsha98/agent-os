// Pure helpers for the version checks (SP5, spec "Version check service", R37):
// compare two version texts and read what an agent's own check printed. Nothing
// here starts a process or touches the network, so they are all easy to test.

// The first run of numbers joined by dots: "2.1.309" in "2.1.309 (Claude Code)",
// "0.154.0" in "codex-cli 0.154.0", "0.22.5" in "v0.22.5". A lone integer, or a
// text with no such run, has no version number.
const VERSION_RUN = /\d+(?:\.\d+)+/;

export function versionNumber(text) {
  const match = VERSION_RUN.exec(String(text ?? ""));
  return match ? match[0] : null;
}

// -1 when a is older than b, 0 when equal, 1 when newer, null when either text
// has no version number (so nobody has to guess which is newer). The parts are
// compared as numbers ("0.10.0" is newer than "0.9.0"); a missing part is 0, so
// "1.0" equals "1.0.0". Anything after the number (a build hash, "-beta") is ignored.
export function compareVersions(a, b) {
  const left = versionNumber(a);
  const right = versionNumber(b);
  if (!left || !right) return null;
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const x = leftParts[index] ?? 0;
    const y = rightParts[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// The npm registry's dist-tags answer, e.g. {"latest":"2.1.310","next":"2.2.0-beta.1"}.
// Returns the "latest" tag, or null when the answer is not JSON, has no latest tag,
// or the tag holds no version number.
export function parseDistTags(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const latest = typeof data.latest === "string" ? data.latest.trim() : "";
  return versionNumber(latest) ? latest : null;
}

// Where the object that starts at source[open] (a "{") ends: the index of its
// matching "}", or -1 when it never closes. Braces inside strings do not count.
function endOfObject(source, open) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

// The last JSON object in a CLI's output, or null. A CLI may print a banner or a
// notice before or after its JSON, so this looks for a "{" that starts a line,
// reads to its matching "}", and keeps the last one that parses as an object.
function lastJsonObject(text) {
  const source = String(text ?? "");
  const lineStarts = /^[ \t]*\{/gm;
  let last = null;
  let readUpTo = 0;
  let match;
  while ((match = lineStarts.exec(source))) {
    const open = match.index + match[0].length - 1;
    if (open < readUpTo) continue; // inside an object that was already read
    const close = endOfObject(source, open);
    if (close === -1) continue;
    try {
      const value = JSON.parse(source.slice(open, close + 1));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        last = value;
        readUpTo = close + 1;
      }
    } catch {
      // not JSON: keep looking at the next line
    }
  }
  return last;
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// What `openclaw update --dry-run --json` printed: its top-level currentVersion,
// targetVersion, restart (will its Gateway restart?) and downgradeRisk (would the
// update go to an OLDER version?). A flag counts only when it is exactly true.
// Null when no JSON object with a version in it can be found.
export function parseOpenclawDryRun(stdout) {
  const data = lastJsonObject(stdout);
  if (!data) return null;
  const current = textOrNull(data.currentVersion);
  const target = textOrNull(data.targetVersion);
  if (!current && !target) return null;
  return { current, target, restartsGateway: data.restart === true, downgradeRisk: data.downgradeRisk === true };
}

// What `hermes update --check` printed: "✓ Already up to date." or
// "⚕ Update available: 3 commits behind origin/main." (it gives no version
// number). A verdict counts only on an exit code of 0 (1 and 2 mean the check
// itself failed, e.g. its git fetch), and only at the start of a line, past any
// symbol, so a notice around it cannot be mistaken for the answer.
export function parseHermesCheck({ code, stdout } = {}) {
  if (code !== 0) return null;
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (lines.some((line) => /^\W*update available\b/i.test(line))) return "available";
  if (lines.some((line) => /^\W*already up to date\b/i.test(line))) return "up-to-date";
  return null;
}
