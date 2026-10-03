// The only thing a Team Room can ever DO to your computer: save one small
// text file (.md, .txt or .html) into its own folder, workspace/team/<room>/.
// It happens when both agents agreed (or when you approved a card), only
// while the execution gate is on, and it can be undone.
//
// Safety, in layers: the file name must match a strict pattern; the folder is
// fixed by us (never by an agent); the workspace writer sanitises again and
// refuses anything outside the sandbox; and Undo only touches the exact file
// this room recorded, after re-checking that the recorded path is still ours.
import { promises as fs } from "node:fs";
import path from "node:path";
import { isExecutionEnabled } from "../execution-gate.js";
import { runtimePaths } from "../store.js";
import {
  assertNoLinksOnPath,
  assertNotALink,
  readFileNoFollow,
  writeFileNoFollow,
  writeWorkspaceText
} from "../workspace.js";
import {
  ACTION_ID_PATTERN,
  appendEvent,
  backupsDir,
  roomError,
  roomShort,
  scrubPaths,
  updateDecision
} from "./room-store.js";

// Same rule the protocol uses, written strictly: one plain file name, an
// allowed extension, no "--" (the workspace writer would collapse it and the
// name would no longer match what we recorded).
const SAFE_FILE_NAME = /^(?!.*--)[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(md|txt|html)$/;

export function isSafeFileName(name) {
  return typeof name === "string" && SAFE_FILE_NAME.test(name);
}

function roomFolder(roomId) {
  return path.resolve(runtimePaths().workspace, "team", roomShort(roomId));
}

// The absolute path of a file this room may touch, or null if the pieces do
// not describe exactly "<workspace>/team/<room>/<name>".
function ownedFilePath(roomId, name) {
  if (!isSafeFileName(name)) return null;
  const folder = roomFolder(roomId);
  const target = path.resolve(folder, name);
  return path.relative(folder, target) === name ? target : null;
}

// Looks at what is REALLY on disk and refuses links: the room's folders must
// not be links, the folder must resolve to where we expect inside the real
// workspace, and the file itself must not be a link. Returns the absolute
// path to use. Throws an error with code "link_refused".
async function checkedTarget(roomId, name) {
  const lexical = ownedFilePath(roomId, name);
  if (!lexical) throw roomError(400, "bad_file_name", "That file name is not allowed.");
  await fs.mkdir(runtimePaths().workspace, { recursive: true });
  const realWorkspace = await fs.realpath(runtimePaths().workspace);
  const folderParts = ["team", roomShort(roomId)];
  await assertNoLinksOnPath(realWorkspace, folderParts);
  const expectedFolder = path.join(realWorkspace, ...folderParts);
  try {
    if ((await fs.realpath(expectedFolder)) !== expectedFolder) {
      const error = new Error("refused: a folder on the path is a link");
      error.code = "link_refused";
      throw error;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const target = path.join(expectedFolder, name);
  await assertNotALink(target);
  return target;
}

function actionEventFields(action) {
  return {
    actionId: action.id,
    proposalId: action.proposalId,
    kind: action.kind,
    path: action.path,
    created: action.created,
    updated: action.updated
  };
}

// Saves an agreed (or user-approved) file proposal. Returns the action
// record. Throws a roomError with code "execution_gate_off" when the gate is
// off, which the caller turns into "needs your approval".
export async function applyFileProposal(roomId, proposalId) {
  if (!(await isExecutionEnabled())) {
    throw roomError(403, "execution_gate_off", "Turn on the execution gate to let the room save files.");
  }
  const action = await updateDecision(roomId, async (decision) => {
    const proposal = decision.proposals.find((p) => p.id === proposalId);
    if (!proposal) throw roomError(404, "proposal_not_found", "Proposal not found.");
    if (proposal.kind !== "file" || !proposal.file) {
      throw roomError(409, "not_a_file_proposal", "That proposal is not a file proposal.");
    }
    if (proposal.status !== "agreed" && proposal.status !== "needs_approval") {
      throw roomError(409, "proposal_not_ready", `That proposal is ${proposal.status}.`);
    }
    const name = proposal.file.name;
    const target = ownedFilePath(roomId, name);
    if (!target) throw roomError(400, "bad_file_name", "That file name is not allowed.");

    const actionId = `A${decision.actions.length + 1}`;
    let backup = null;
    let before = null;
    let written;
    try {
      const target = await checkedTarget(roomId, name);
      before = await readFileNoFollow(target);
      if (before !== null) {
        // The workspace writer overwrites without a backup, so keep our own.
        backup = `${actionId}-${name}`;
        await fs.mkdir(backupsDir(roomId), { recursive: true });
        await fs.writeFile(path.join(backupsDir(roomId), backup), before, { encoding: "utf8", mode: 0o600 });
      }
      written = await writeWorkspaceText(
        { relativePath: `team/${roomShort(roomId)}/${name}`, content: proposal.file.content },
        { maxParts: 3 }
      );
    } catch (error) {
      if (error?.code !== "link_refused") throw error;
      // A link where the file should be: write nothing, keep nothing, and say so.
      if (backup) await fs.rm(path.join(backupsDir(roomId), backup), { force: true });
      const refused = {
        id: actionId,
        proposalId,
        kind: "file_write",
        path: `team/${roomShort(roomId)}/${name}`,
        created: false,
        updated: false,
        backup: null,
        failed: true,
        failReason: error.message,
        at: new Date().toISOString(),
        undone: false,
        undoneAt: null
      };
      decision.actions.push(refused);
      proposal.status = "refused";
      proposal.statusReason = error.message;
      proposal.actionId = actionId;
      return refused;
    }
    const record = {
      id: actionId,
      proposalId,
      kind: "file_write",
      path: written.file.relativePath,
      created: before === null,
      updated: before !== null,
      backup,
      at: new Date().toISOString(),
      undone: false,
      undoneAt: null
    };
    decision.actions.push(record);
    proposal.status = "applied";
    proposal.actionId = actionId;
    return record;
  });
  if (action.failed) {
    const message = scrubPaths(`${action.failReason}. Nothing was written.`);
    await appendEvent(roomId, { type: "protocol_note", agentId: null, message });
    await appendEvent(roomId, { type: "proposal_status", proposalId, status: "refused", reason: message, actionId: action.id });
    return action;
  }
  await appendEvent(roomId, { type: "action", ...actionEventFields(action) });
  await appendEvent(roomId, { type: "proposal_status", proposalId, status: "applied", actionId: action.id });
  return action;
}

// Puts things back: restores the saved copy, or deletes the file if this room
// created it. Works once per action.
//
// Undo is deliberately NOT blocked by the execution gate. It only puts back
// what was there before (a safety action), so someone who turned the gate off
// because something looked wrong can still reverse what the room did. The
// link checks below still apply to it.
export async function undoAction(roomId, actionId) {
  if (!ACTION_ID_PATTERN.test(String(actionId))) {
    throw roomError(404, "action_not_found", "Action not found.");
  }
  const action = await updateDecision(roomId, async (decision) => {
    const found = decision.actions.find((a) => a.id === actionId);
    if (!found) throw roomError(404, "action_not_found", "Action not found.");
    if (found.undone) throw roomError(409, "already_undone", "That action was already undone.");
    if (found.failed) throw roomError(409, "nothing_to_undo", "That action was refused, so nothing was written.");
    if (found.kind !== "file_write") throw roomError(409, "cannot_undo", "That action cannot be undone.");

    // Only ever touch the exact file this room recorded: the recorded path
    // must be team/<this room>/<safe name>, and the proposal it came from must
    // agree on the name.
    const name = path.posix.basename(String(found.path || ""));
    const target = ownedFilePath(roomId, name);
    const proposal = decision.proposals.find((p) => p.id === found.proposalId);
    if (!target || found.path !== `team/${roomShort(roomId)}/${name}` || (proposal?.file && proposal.file.name !== name)) {
      throw roomError(409, "path_mismatch", "The recorded path does not match this room, so Undo refused.");
    }

    let safeTarget;
    try {
      safeTarget = await checkedTarget(roomId, name);
    } catch (error) {
      if (error?.code === "link_refused") throw roomError(409, "link_refused", `${error.message}. Nothing was changed.`);
      throw error;
    }
    if (found.created) {
      await fs.rm(safeTarget, { force: true });
    } else {
      const backupName = String(found.backup || "");
      if (!backupName || path.basename(backupName) !== backupName || !backupName.startsWith(`${found.id}-`)) {
        throw roomError(409, "backup_missing", "The saved copy for this action is missing.");
      }
      const saved = await readFileNoFollow(path.join(backupsDir(roomId), backupName));
      if (saved === null) throw roomError(409, "backup_missing", "The saved copy for this action is missing.");
      await writeFileNoFollow(safeTarget, saved);
    }
    found.undone = true;
    found.undoneAt = new Date().toISOString();
    return { ...found };
  });
  await appendEvent(roomId, { type: "action_undone", actionId: action.id, proposalId: action.proposalId, path: action.path });
  return action;
}
