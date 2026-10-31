// Keeps a test's session manager from running real git (SP4, Task X7).
// Since X7 a manager reads git (rev-parse, config, status, diff) in the folder
// of every agent session it starts, and again every 3 s. A test that is not
// about the changes panel must not do that: it would spawn real git processes
// for nothing, in whatever folder the test happens to use. Spread these two
// options into the manager's options (before any option the test overrides):
//
//   createSessionManager({ ...NO_GIT_OPTIONS, ...rest })
//
// The stub answers every git call the way git answers outside a repository
// (exit 128, "not a git repository"), so the manager reports "not a git
// project" and never starts a process; the one-hour poll never ticks in a test.
// Only test/sessions-changes.test.js runs real git, inside temp repositories.
// A helper, not a test file: the runner only runs test/*.test.js.
export const NO_GIT_OPTIONS = Object.freeze({
  runGit: async () => ({
    code: 128,
    stdout: "",
    stderr: "fatal: not a git repository (or any of the parent directories): .git",
    timedOut: false,
    ok: false
  }),
  changesPollMs: 3_600_000
});
