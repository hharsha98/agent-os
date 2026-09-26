// Flags that would let a configured CLI bypass its own safety prompts.
// Shared by connections.js (rejects at configure time), modules.js and
// live-chat.js (filtered again at spawn time as defence in depth).
export const BLOCKED_AGENT_FLAGS = [
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
  "--force",
  "danger-full-access",
  "--permission-mode=bypassPermissions",
  "bypassPermissions",
  // Claude Code 2.1.281: "Enable bypassing all permission checks as an
  // option, without it being enabled by default." Same bypass, opt-in form.
  "--allow-dangerously-skip-permissions"
];

export function containsBlockedFlag(value) {
  const text = String(value || "");
  return BLOCKED_AGENT_FLAGS.some((flag) => text.includes(flag));
}
