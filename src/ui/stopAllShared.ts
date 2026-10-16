// The logic behind "Hold to stop all" and the palette's "Stop all agent work" (design spec D11,
// SP2 ruling R14, SP3 ruling R22 and planning decision Q16), with no imports except types, so the
// logic tests can load it straight from src/ with Node. The pieces that talk to Agent OS (listRuns,
// stopRun, listTeamRooms, stopTeamRoom, the sessions list and each session's Stop) and the agent-work
// rule (agentWork.ts) are passed in; stopAll.ts passes the real ones.
//
// What it stops: every session that has not ended, of both kinds (an agent's own terminal, and an
// agent's updater running as an `update` session); every AGENT run that is queued or running; and every
// Team Room that is running (a room between two turns has no active run, so stopping runs alone would
// miss it and its next turn would start), plus the room the server holds its active slot for even if it
// still reads "needs you" (a decision was just made and the room is about to resume).
// It never touches the Hermes background service or the OpenClaw Gateway (it never calls their service
// controls), and it never interrupts Agent OS's own setup jobs: stopping a gateway restart can leave the
// gateway down, and stopping an install can leave a half-installed tool. A session's Stop is the same Stop
// sequence as the Sessions page's Stop session: the agent's own soft stop, then its whole process tree.
import type { RunMeta, TeamRoomSummary } from "../types";

const ACTIVE = new Set(["queued", "running"]);
// The one session status that means there is nothing left to stop. Every other one (starting, live,
// waiting, idle, held, and any we have not heard of) is stopped: an emergency stop errs toward stopping.
const SESSION_ENDED = "exited";

// A hung server must never leave a button on "Stopping…" for ever.
export const LIST_TIMEOUT_MS = 8000;
export const STOP_TIMEOUT_MS = 15000;

// What `stopRoom` hands back when the server said the room was not running: it had ended by itself
// between the look and the stop. It is counted apart, never as a room we stopped.
export const ROOM_ALREADY_ENDED = "room_already_ended";
// The same for a session (withSessionAnswers below): it had ended by itself before the stop reached it.
export const SESSION_ALREADY_ENDED = "session_already_ended";
// What `stopSession` hands back when the server answered but the session still reads as running (a process
// that survived the Stop sequence, say one stuck in uninterruptible I/O). Agent OS did answer, so that is not
// a timeout, and it is not a stop either: it is counted apart and told as "still running after its Stop".
export const SESSION_STILL_RUNNING = "session_still_running";
// The most session Stops asked at once. A browser keeps only about six connections to one address, and a
// session's Stop takes seconds, so more than a few at a time would hold the Team Room and run Stops back.
export const SESSION_STOPS_AT_ONCE = 4;

// The most runs the server returns for one list (the cap in listRuns in
// server/runtime/runs/run-manager.js). It lists the newest first and cannot
// filter by status, so if the list comes back full, older runs were not seen.
export const MAX_RUNS = 1000;

export type StoppableRun = Pick<RunMeta, "id" | "kind" | "status"> & { title?: string };
export type StoppableRoom = Pick<TeamRoomSummary, "id" | "status"> & { task?: string };
// The fields of a session (GET /api/sessions?kind=all; SessionSummary in
// server/runtime/sessions/manager.js) that this logic reads. A full SessionSummary fits it.
export interface StoppableSession {
  id: string;
  status: string;
  kind?: string;
  agentId?: string;
  agentLabel?: string;
  folderName?: string;
  folderShown?: boolean;
}

export interface StopAllDeps {
  listRuns: (limit: number) => Promise<{ runs: StoppableRun[] }>;
  stopRun: (id: string) => Promise<unknown>;
  // `activeRoomId` is the room the server holds its one active slot for (GET /api/team-rooms). Older
  // servers do not send it.
  listRooms: () => Promise<{ rooms: StoppableRoom[]; activeRoomId?: string | null }>;
  stopRoom: (id: string) => Promise<unknown>;
  // Every session of both kinds (GET /api/sessions?kind=all) and one session's Stop
  // (POST /api/sessions/:id/stop, which answers the session's summary).
  listSessions: () => Promise<{ sessions: StoppableSession[] }>;
  stopSession: (id: string) => Promise<unknown>;
  isAgentWork: (run: { kind: string }) => boolean;
}

// Wraps the real requests so that a stop the server answers with `room_not_running` (the room ended
// by itself between the look and the stop) hands back ROOM_ALREADY_ENDED instead of failing. That is
// not a failure, and it is not a stop we made either: the words count it apart. Any other refusal
// still fails as before. Lives here, not in stopAll.ts, so the logic tests can reach it.
export function withEndedRooms(deps: StopAllDeps): StopAllDeps {
  return {
    ...deps,
    stopRoom: async (id) => {
      try {
        return await deps.stopRoom(id);
      } catch (error) {
        const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
        if (code === "room_not_running") return ROOM_ALREADY_ENDED;
        throw error;
      }
    }
  };
}

// The short code of a refusal. A TeamRoomError carries it in `code`; an ApiError (src/api.ts request())
// keeps the server's short code in `message`.
function refusalCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, name, message } = error as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof code === "string") return code;
  return name === "ApiError" && typeof message === "string" ? message : undefined;
}

// A Stop answer (the session's summary) that says the session had ended before this stop: it reads
// "exited", and not because of a Stop (it ended by itself, or when Agent OS quit).
function endedOnItsOwn(answer: unknown): boolean {
  if (typeof answer !== "object" || answer === null) return false;
  const { status, endedBy } = answer as { status?: unknown; endedBy?: unknown };
  return status === SESSION_ENDED && endedBy !== "stop";
}

// A Stop answer (the session's summary) whose status is a word other than "exited": the Stop sequence ran,
// but the session is still running. An answer with no status word (a shape we do not know) is still a yes.
function stillRunning(answer: unknown): boolean {
  if (typeof answer !== "object" || answer === null) return false;
  const { status } = answer as { status?: unknown };
  return typeof status === "string" && status !== SESSION_ENDED;
}

// Wraps the real session requests:
// - the list: sessions exist only when Agent OS runs on this computer (local mode). Anywhere else every
//   sessions route answers `not_available`, so no session can be running: that is a list read, with
//   nothing in it. Any other failure still means the list could not be read.
// - one stop: `unknown_session`, `session_busy` (409: an ended session that is being resumed or dismissed
//   right now), or an answer that says the session had ended by itself, hands back SESSION_ALREADY_ENDED
//   (counted apart, never as a session we stopped). An answer that says the session is still running hands
//   back SESSION_STILL_RUNNING (counted apart, never as a stop and never as a timeout: Agent OS did answer).
//   Any other refusal still fails.
export function withSessionAnswers(deps: StopAllDeps): StopAllDeps {
  return {
    ...deps,
    listSessions: async () => {
      try {
        return await deps.listSessions();
      } catch (error) {
        if (refusalCode(error) === "not_available") return { sessions: [] };
        throw error;
      }
    },
    stopSession: async (id) => {
      try {
        const answer = await deps.stopSession(id);
        if (endedOnItsOwn(answer)) return SESSION_ALREADY_ENDED;
        return stillRunning(answer) ? SESSION_STILL_RUNNING : answer;
      } catch (error) {
        const code = refusalCode(error);
        if (code === "unknown_session" || code === "session_busy") return SESSION_ALREADY_ENDED;
        throw error;
      }
    }
  };
}

// What a look found. A list that could not be read leaves its part empty and its
// `...Checked` flag false: "nothing found" is only said when the list was read.
export interface StopLook {
  runs: StoppableRun[];
  rooms: StoppableRoom[];
  sessions: StoppableSession[];
  // Active runs left alone on purpose because they are setup or service jobs.
  skipped: number;
  // True when the run list was full, so older runs may not have been checked.
  listTruncated: boolean;
  runsChecked: boolean;
  roomsChecked: boolean;
  sessionsChecked: boolean;
}

export interface StopAllResult {
  // Active agent runs we tried to stop, and how each went. `timedOut` = no answer in time, so
  // the run may well have stopped, or may still be running: it is not "could not be stopped".
  found: number;
  stopped: number;
  failed: number;
  timedOut: number;
  // Running Team Rooms we tried to stop, and how each went.
  rooms: number;
  roomsStopped: number;
  roomsFailed: number;
  roomsTimedOut: number;
  // Rooms among those that had already ended by themselves when the stop reached them.
  // They are part of `rooms`, but not of `roomsStopped`.
  roomsAlreadyEnded: number;
  // Sessions (both kinds) that had not ended, and how each stop went, counted the same way.
  sessions: number;
  sessionsStopped: number;
  sessionsFailed: number;
  sessionsTimedOut: number;
  sessionsAlreadyEnded: number;
  // Sessions among those whose Stop was answered, but that still read as running afterwards. They are part
  // of `sessions`, but not of `sessionsStopped`, and not of `sessionsTimedOut` (Agent OS did answer).
  sessionsStillRunning: number;
  // OpenClaw sessions among the stopped ones: their terminal is closed, but OpenClaw's Gateway may
  // still finish the step it was on (spec "Stop sequence"), so the words say so.
  openClawStopped: number;
  skipped: number;
  runsChecked: boolean;
  roomsChecked: boolean;
  sessionsChecked: boolean;
  // Nothing could be read at all: nothing was stopped.
  unreachable: boolean;
  listTruncated: boolean;
}

type Outcome = "ok" | "timeout" | "error" | "ended" | "running";

// Waits for a promise for at most `ms`. Never rejects: it says how it went. A timeout is not an
// error: the request may well have been carried out.
function attempt(promise: Promise<unknown>, ms: number): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value === ROOM_ALREADY_ENDED || value === SESSION_ALREADY_ENDED ? "ended" : value === SESSION_STILL_RUNNING ? "running" : "ok");
      },
      () => {
        clearTimeout(timer);
        resolve("error");
      }
    );
  });
}

// The answer, or null when the request failed or did not answer in time.
async function readWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      })
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// The sessions of a list that are worth a Stop: every one that has not ended. An entry with no usable id
// cannot be stopped by id, so it is never sent.
function stoppableSessions(list: StoppableSession[]): StoppableSession[] {
  return list.filter(
    (session) => typeof session === "object" && session !== null && typeof session.id === "string" && session.id !== "" && session.status !== SESSION_ENDED
  );
}

// Looks at what is running. Never throws.
//
// A room is stoppable when it reads "running", and also when the server names it as its active room
// whatever it reads: a room whose decision was just made can still read "needs you" on disk while the
// server already holds its one active slot and is getting ready to resume it. Asking the server which
// room that is costs nothing extra: it comes with the same room list.
export async function lookForStoppable(deps: StopAllDeps): Promise<StopLook> {
  const [runsAnswer, roomsAnswer, sessionsAnswer] = await Promise.all([
    readWithin(Promise.resolve().then(() => deps.listRuns(MAX_RUNS)), LIST_TIMEOUT_MS),
    readWithin(Promise.resolve().then(() => deps.listRooms()), LIST_TIMEOUT_MS),
    readWithin(Promise.resolve().then(() => deps.listSessions()), LIST_TIMEOUT_MS)
  ]);
  // A reply that is not a list is treated like no reply: we could not check.
  const runList = runsAnswer && Array.isArray(runsAnswer.runs) ? runsAnswer.runs : null;
  const roomList = roomsAnswer && Array.isArray(roomsAnswer.rooms) ? roomsAnswer.rooms : null;
  const sessionList = sessionsAnswer && Array.isArray(sessionsAnswer.sessions) ? sessionsAnswer.sessions : null;
  const activeId = roomList && typeof roomsAnswer?.activeRoomId === "string" && roomsAnswer.activeRoomId ? roomsAnswer.activeRoomId : null;
  const active = (runList || []).filter((run) => ACTIVE.has(run.status));
  const runs = active.filter((run) => deps.isAgentWork(run));
  const rooms = (roomList || []).filter((room) => room.status === "running" || room.id === activeId);
  // The server holds a room the list did not show (the list is capped): it is still stopped.
  if (activeId !== null && !rooms.some((room) => room.id === activeId)) rooms.push({ id: activeId, status: "running" });
  const sessions = stoppableSessions(sessionList || []);
  return {
    runs,
    rooms,
    sessions,
    skipped: active.length - runs.length,
    listTruncated: runList !== null && runList.length >= MAX_RUNS,
    runsChecked: runList !== null,
    roomsChecked: roomList !== null,
    sessionsChecked: sessionList !== null
  };
}

function tally(outcomes: Outcome[]) {
  return {
    stopped: outcomes.filter((o) => o === "ok").length,
    failed: outcomes.filter((o) => o === "error").length,
    timedOut: outcomes.filter((o) => o === "timeout").length,
    alreadyEnded: outcomes.filter((o) => o === "ended").length,
    stillRunning: outcomes.filter((o) => o === "running").length
  };
}

// Stops these sessions, at most SESSION_STOPS_AT_ONCE at a time; the rest wait for a free place. Each Stop has
// its own time limit, which starts when that Stop is asked. Never rejects: it says how each one went.
async function stopSessionsInPlaces(deps: StopAllDeps, sessions: StoppableSession[]): Promise<Outcome[]> {
  const outcomes: Outcome[] = new Array(sessions.length);
  let next = 0;
  async function place() {
    while (next < sessions.length) {
      const index = next++;
      outcomes[index] = await attempt(Promise.resolve().then(() => deps.stopSession(sessions[index].id)), STOP_TIMEOUT_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(SESSION_STOPS_AT_ONCE, sessions.length) }, () => place()));
  return outcomes;
}

// One more look at the sessions running now, once their Stops have finished (the hold only, see
// stopWhatWasFound): a session whose "New session" request was still being answered when the look was made is
// not in the first list, and starts a moment later. Returns the ones the first list did not hold. A list that
// cannot be read adds nothing.
async function sessionsStartedLate(deps: StopAllDeps, known: StoppableSession[]): Promise<StoppableSession[]> {
  const answer = await readWithin(Promise.resolve().then(() => deps.listSessions()), LIST_TIMEOUT_MS);
  if (!answer || !Array.isArray(answer.sessions)) return [];
  const seen = new Set(known.map((session) => session.id));
  return stoppableSessions(answer.sessions).filter((session) => !seen.has(session.id));
}

// Stops what the look found. Sessions and rooms start together (planning decision Q16). Runs follow the
// rooms: stopping a room sets its "stop" flag as well as stopping its current turn, so no next turn starts
// when that turn ends. Runs never wait for a session, whose Stop takes a few seconds (the agent's soft stop,
// then the kill), and the sessions are stopped a few at a time so they cannot use up the connections the
// rooms and runs need. Rooms and runs are not read again afterwards.
//
// `lookAgainForSessions` is for the hold only (stopEverythingWith): the hold names nothing before it stops, so
// a session that was still starting when it looked is stopped too (see sessionsStartedLate). The palette's
// confirm does not set it: its dialog listed what would be stopped, and "Stop 2 sessions" must stop those 2,
// not a third one that the dialog never showed. A session that starts after the dialog looked is left for
// the Sessions page.
export async function stopWhatWasFound(
  deps: StopAllDeps,
  look: StopLook,
  options: { lookAgainForSessions?: boolean } = {}
): Promise<StopAllResult> {
  const firstSessions = look.sessions ?? [];
  const sessionsDone = stopSessionsInPlaces(deps, firstSessions);
  const roomOutcomes = await Promise.all(
    look.rooms.map((room) => attempt(Promise.resolve().then(() => deps.stopRoom(room.id)), STOP_TIMEOUT_MS))
  );
  const runOutcomes = await Promise.all(
    look.runs.map((run) => attempt(Promise.resolve().then(() => deps.stopRun(run.id)), STOP_TIMEOUT_MS))
  );
  const firstOutcomes = await sessionsDone;
  const sessionsChecked = look.sessionsChecked === true;
  // Only for the hold, and only when the first list was read: a list that already failed is not asked again.
  const lateSessions = options.lookAgainForSessions === true && sessionsChecked ? await sessionsStartedLate(deps, firstSessions) : [];
  const lateOutcomes = await stopSessionsInPlaces(deps, lateSessions);
  const sessionList = [...firstSessions, ...lateSessions];
  const sessionOutcomes = [...firstOutcomes, ...lateOutcomes];
  const runs = tally(runOutcomes);
  const rooms = tally(roomOutcomes);
  const sessions = tally(sessionOutcomes);
  return {
    found: look.runs.length,
    stopped: runs.stopped,
    failed: runs.failed,
    timedOut: runs.timedOut,
    rooms: look.rooms.length,
    roomsStopped: rooms.stopped,
    roomsFailed: rooms.failed,
    roomsTimedOut: rooms.timedOut,
    roomsAlreadyEnded: rooms.alreadyEnded,
    sessions: sessionList.length,
    sessionsStopped: sessions.stopped,
    sessionsFailed: sessions.failed,
    sessionsTimedOut: sessions.timedOut,
    sessionsAlreadyEnded: sessions.alreadyEnded,
    sessionsStillRunning: sessions.stillRunning,
    openClawStopped: sessionList.filter((session, index) => bringsOpenClawNote(session) && sessionOutcomes[index] === "ok").length,
    skipped: look.skipped,
    runsChecked: look.runsChecked,
    roomsChecked: look.roomsChecked,
    sessionsChecked,
    unreachable: !look.runsChecked && !look.roomsChecked && !sessionsChecked,
    listTruncated: look.listTruncated
  };
}

// The hold: look, then stop what was found, then look once more for a session that was still starting.
export async function stopEverythingWith(deps: StopAllDeps): Promise<StopAllResult> {
  return stopWhatWasFound(deps, await lookForStoppable(deps), { lookAgainForSessions: true });
}

// ---- the words ----------------------------------------------------------------

const runWord = (n: number) => `${n} run${n === 1 ? "" : "s"}`;
const roomWord = (n: number) => `${n} Team Room${n === 1 ? "" : "s"}`;
const sessionWord = (n: number) => `${n} session${n === 1 ? "" : "s"}`;

// "a", "a and b", "a, b and c".
function listWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// Where to look afterwards: Sessions for sessions, Runs for runs, Team Room for rooms.
function checkWhere(runs: number, rooms: number, sessions = 0): string {
  const places: string[] = [];
  if (sessions > 0) places.push("Sessions");
  if (runs > 0) places.push("Runs");
  if (rooms > 0) places.push("Team Room");
  return `check ${listWords(places.length > 0 ? places : ["Runs"])}`;
}

// "2 runs", "1 Team Room", "2 runs and 1 Team Room", "1 session, 2 runs and 1 Team Room".
export function thingsWord(runs: number, rooms: number, sessions = 0): string {
  const parts: string[] = [];
  if (sessions > 0) parts.push(sessionWord(sessions));
  if (runs > 0) parts.push(runWord(runs));
  if (rooms > 0) parts.push(roomWord(rooms));
  return parts.length > 0 ? listWords(parts) : runWord(0);
}

// OpenClaw's terminal closes, but its Gateway may still finish the step it was on (spec "Stop sequence"): the
// dialog and the result both say so. A setup session (OpenClaw's ChatGPT sign-in) has no last step to finish, so
// it never brings the OpenClaw note, in the dialog or in the result.
export function bringsOpenClawNote(session: Pick<StoppableSession, "agentId" | "kind">): boolean {
  return session.agentId === "openclaw" && session.kind !== "setup";
}

// How the palette's list names a session: the same words as the Sessions page (sessionTitle in
// src/ui/sessionsShared.ts): "<agent> · <folder>", "<agent> · Set by OpenClaw", "<agent> update".
// "—" means unknown.
export function sessionStopTitle(session: StoppableSession): string {
  const agent = session.agentLabel || session.agentId || "Agent";
  // The same first branch as sessionTitle (a test keeps the two equal): a setup session is OpenClaw's ChatGPT sign-in.
  if (session.kind === "setup") return `${agent} · ChatGPT sign-in`;
  if (session.kind === "update") return `${agent} update`;
  if (session.folderShown === false) return `${agent} · Set by OpenClaw`;
  return `${agent} · ${session.folderName || "—"}`;
}

export function stopAllMessage(result: StopAllResult): { message: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  if (result.unreachable) {
    return {
      message: "Couldn't reach Agent OS, so nothing was stopped. Try again, or stop each session on Sessions and each run on Runs.",
      tone: "danger"
    };
  }
  // A result from before sessions were stopped has no session fields: they read as "checked, none".
  const sessionsFound = result.sessions ?? 0;
  const sessionsStopped = result.sessionsStopped ?? 0;
  const sessionsFailed = result.sessionsFailed ?? 0;
  const sessionsTimedOut = result.sessionsTimedOut ?? 0;
  const sessionsEnded = result.sessionsAlreadyEnded ?? 0;
  const sessionsStillRunning = result.sessionsStillRunning ?? 0;
  const sessionsChecked = result.sessionsChecked !== false;
  // Said whenever the list was full: never claim "nothing was running" then.
  const notChecked = result.listTruncated ? " Older runs were not checked." : "";
  // Said for every list that could not be read: what it holds was not stopped.
  const unread = [
    result.runsChecked ? "" : " Couldn't read the list of runs, so no run was stopped. Check Runs.",
    sessionsChecked ? "" : " Couldn't read the list of sessions, so no session was stopped. Check Sessions.",
    result.roomsChecked ? "" : " Couldn't read the list of Team Rooms, so a room that is between two turns may still carry on. Check Team Room."
  ].join("");
  // Said whenever setup or service jobs were left running, so the person knows why.
  const left =
    result.skipped === 0
      ? ""
      : result.skipped === 1
        ? " 1 setup or service job was left running. It is not agent work; manage it in Setup or Agents."
        : ` ${result.skipped} setup or service jobs were left running. They are not agent work; manage them in Setup or Agents.`;
  const total = result.found + result.rooms + sessionsFound;
  if (total === 0) {
    if (unread) {
      // A list could not be read, so "nothing was running" cannot be said; the run list, if read, had nothing to stop.
      const head = result.runsChecked ? "No agent run was running." : "";
      return { message: `${head}${unread}${left}`.trim(), tone: "warn" };
    }
    if (result.listTruncated) {
      const head = result.skipped > 0 ? `No agent work was running in the newest ${MAX_RUNS} runs.` : `None of the newest ${MAX_RUNS} runs were running.`;
      return { message: `${head}${left}${notChecked}`, tone: "warn" };
    }
    const head = result.skipped > 0 ? "No agent work was running, so there was nothing to stop." : "Nothing was running, so there was nothing to stop.";
    return { message: `${head}${left}`, tone: "neutral" };
  }
  const stoppedAny = result.stopped + result.roomsStopped + sessionsStopped > 0;
  const failedAny = result.failed + result.roomsFailed + sessionsFailed > 0;
  const timedOutAny = result.timedOut + result.roomsTimedOut + sessionsTimedOut > 0;
  const stillRunningAny = sessionsStillRunning > 0;
  // Rooms and sessions that ended by themselves before the stop reached them: said apart, never as "stopped".
  const roomsEnded = result.roomsAlreadyEnded ?? 0;
  const endedAny = roomsEnded + sessionsEnded > 0;
  const parts: string[] = [];
  if (stoppedAny) parts.push(`Stopped ${thingsWord(result.stopped, result.roomsStopped, sessionsStopped)}.`);
  else if (failedAny || timedOutAny || stillRunningAny || !endedAny) parts.push("Nothing was confirmed stopped.");
  if (failedAny) {
    parts.push(
      `${thingsWord(result.failed, result.roomsFailed, sessionsFailed)} could not be stopped: ${checkWhere(result.failed, result.roomsFailed, sessionsFailed)}.`
    );
  }
  if (timedOutAny) {
    // No answer is not "could not be stopped": the stop may have gone through.
    const n = result.timedOut + result.roomsTimedOut + sessionsTimedOut;
    parts.push(
      `Agent OS did not answer in time about ${thingsWord(result.timedOut, result.roomsTimedOut, sessionsTimedOut)}, so ${n === 1 ? "it" : "they"} may still be running: ${checkWhere(result.timedOut, result.roomsTimedOut, sessionsTimedOut)}.`
    );
  }
  if (stillRunningAny) {
    // Agent OS did answer: the Stop ran and the session still reads as running. Said as what it is, not as no answer.
    parts.push(
      `${sessionWord(sessionsStillRunning)} ${sessionsStillRunning === 1 ? "is" : "are"} still running after ${sessionsStillRunning === 1 ? "its" : "their"} Stop: ${checkWhere(0, 0, sessionsStillRunning)}.`
    );
  }
  if (endedAny) {
    // "So there was nothing to stop" is said only when that is known: nothing else happened and every list
    // was read in full. With a list that could not be read (or was full), only what was seen is said.
    const ended = thingsWord(0, roomsEnded, sessionsEnded);
    const onlyEnded = !stoppedAny && !failedAny && !timedOutAny && !stillRunningAny && !unread && !result.listTruncated;
    parts.push(onlyEnded ? `${ended} had already ended, so there was nothing to stop.` : `${ended} had already ended.`);
  }
  // OpenClaw's terminal is closed, but its Gateway may still finish the step it was on (spec "Stop sequence").
  if ((result.openClawStopped ?? 0) > 0) parts.push("OpenClaw may still be finishing its last step.");
  const clean = !failedAny && !timedOutAny && !stillRunningAny;
  const calm = clean && !result.listTruncated && !unread;
  return {
    message: `${parts.join(" ")}${unread}${left}${notChecked}`,
    tone: calm ? (stoppedAny ? "ok" : "neutral") : "warn"
  };
}
