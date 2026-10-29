// The approvals of the fake `openclaw` (test/fakes/tui-agent.mjs; SP4, Task
// X3): rows in the shape `openclaw approvals pending --json` prints (OpenClaw
// 2026.10.4: id, kind, agentId, sessionKey, createdAtMs, expiresAtMs, summary;
// every value made up), and the two knobs that pick what the fake's `approvals
// pending --json` and `approvals resolve <id> <decision>` do. The knobs are
// files under $HOME/.fake-knobs (test/helpers/fake-knobs.js), because a
// session's environment is the login shell's, not the test's.
// A helper, not a test file: the runner only runs test/*.test.js.
import { setFakeKnob } from "./fake-knobs.js";

let counter = 0;

// One pending approval: an exec approval created now that expires in five
// minutes, unless `extra` says otherwise.
export function fakeApproval(extra = {}) {
  counter += 1;
  const createdAtMs = Date.now();
  return {
    id: `appr-${counter}`,
    kind: "exec",
    agentId: "main",
    sessionKey: null,
    createdAtMs,
    expiresAtMs: createdAtMs + 5 * 60 * 1000,
    summary: "npm run build",
    ...extra
  };
}

export function pendingJson(rows) {
  return JSON.stringify({ approvals: rows });
}

// FAKE_OPENCLAW_APPROVALS: rows (printed as pendingJson), a string as it is
// ("fail", "slow" or any text), or null for the default ({"approvals":[]}).
export async function setFakeApprovals(home, value) {
  await setFakeKnob(home, "FAKE_OPENCLAW_APPROVALS", Array.isArray(value) ? pendingJson(value) : value);
}

// FAKE_OPENCLAW_RESOLVE: "fail", "slow", or null (exit 0).
export async function setFakeResolve(home, value) {
  await setFakeKnob(home, "FAKE_OPENCLAW_RESOLVE", value);
}
