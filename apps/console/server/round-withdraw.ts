/**
 * `withdrawRound`: marks a round the owner should no longer answer, because its PR moved to a new head,
 * closed, or had its gate answered elsewhere. It writes `withdrawn.json` beside `round.json` once, with
 * `O_CREAT|O_EXCL|O_NOFOLLOW` and mode 0600, so a second withdraw keeps the first reason. An answered
 * round is never withdrawn: the owner's answer stands. A submit racing this write can leave both files;
 * `feedback.json` then wins everywhere the console reads them.
 *
 * Only `titan-console rounds withdraw` calls it, never `/rpc`: the factory withdraws, the owner does not.
 */
import { constants } from "node:fs";
import { lstat, open, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { FEEDBACK_FILE, ROUND_ID, WITHDRAWN_FILE, WITHDRAWN_SCHEMA_ID } from "./rounds.js";

/** `new-head` may name the sha the PR moved to. */
const WITHDRAW_REASON = /^(new-head(:[0-9a-f]{40})?|closed|answered-elsewhere)$/;
/** `O_EXCL` already refuses a symlink at the name; `O_NOFOLLOW` keeps that true if the flags ever change. */
export const WITHDRAW_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

interface WithdrawResult {
  id: string;
  outcome: "withdrawn" | "already-withdrawn" | "kept-answered";
}

const refuse = (message: string, code: number = EXIT.DATAERR): never => {
  throw failure(`withdraw refused: ${message}`, code);
};

const errnoOf = (error: unknown): unknown => (error instanceof Error && "code" in error ? error.code : undefined);

async function lstatOrNull(file: string) {
  return lstat(file).catch((error: unknown) => (errnoOf(error) === "ENOENT" ? null : refuse(`${path.basename(file)} could not be checked`, EXIT.UNAVAILABLE)));
}

async function roundDirOf(roundsDir: string, id: string): Promise<string> {
  if (!ROUND_ID.test(id)) refuse(`round id "${id}" is not a plain name`);
  const roundDir = path.join(path.resolve(roundsDir), id);
  const stats = await lstatOrNull(roundDir);
  if (stats === null) refuse(`no round named "${id}"`, EXIT.NOINPUT);
  if (!stats?.isDirectory()) refuse(`${id} in the rounds dir is a symlink or not a directory`);
  return roundDir;
}

/** False when the file already exists as a regular file; anything else at the name is refused. */
async function writeOnce(file: string, bytes: Buffer): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(file, WITHDRAW_FLAGS, 0o600);
  } catch (error) {
    if (errnoOf(error) !== "EEXIST") return refuse(`${WITHDRAWN_FILE} could not be created`, EXIT.UNAVAILABLE);
    if ((await lstatOrNull(file))?.isFile()) return false;
    return refuse(`${WITHDRAWN_FILE} is a symlink or not a regular file`);
  }
  try {
    await handle.writeFile(bytes);
  } catch {
    await handle.close();
    await rm(file, { force: true });
    return refuse(`${WITHDRAWN_FILE} could not be written`, EXIT.UNAVAILABLE);
  }
  await handle.close();
  return true;
}

export async function withdrawRound(roundsDir: string, id: string, reason: string, now = new Date()): Promise<WithdrawResult> {
  if (!WITHDRAW_REASON.test(reason)) refuse(`reason "${reason}" is not new-head[:<sha>], closed or answered-elsewhere`, EXIT.USAGE);
  const roundDir = await roundDirOf(roundsDir, id);
  if ((await lstatOrNull(path.join(roundDir, FEEDBACK_FILE)))?.isFile()) return { id, outcome: "kept-answered" };
  const bytes = Buffer.from(`${JSON.stringify({ schema: WITHDRAWN_SCHEMA_ID, reason, at: now.toISOString() })}\n`);
  return { id, outcome: (await writeOnce(path.join(roundDir, WITHDRAWN_FILE), bytes)) ? "withdrawn" : "already-withdrawn" };
}
