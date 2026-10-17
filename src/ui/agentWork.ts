// What counts as an agent doing work (ruling R14), in one small file with no imports.
//
// Run kinds (meta.kind on the server) that are Agent OS's own jobs, not agent work:
// "service" (gateway start, stop, restart), "install", "configure" and "pull" (setup
// jobs) and "signin". Any other kind, including "agent", "team-turn", a missing kind
// and a kind we have not heard of, IS agent work: an emergency stop errs toward
// stopping agent work.
//
// "Hold to stop all" (stopAll.ts) uses this file. Home (homeShared.ts) and the Agents page
// (agentsPageShared.ts) keep their own copy of the list, because the logic tests load those two
// files straight from src/ with Node, and Node cannot follow an import written without a file
// extension. test/agent-work.test.js fails if any copy drifts from this one.
export const NOT_AGENT_WORK: ReadonlySet<string> = new Set(["service", "install", "configure", "signin", "pull"]);

export function isAgentWork(run: { kind: string }): boolean {
  return !NOT_AGENT_WORK.has(run.kind);
}
