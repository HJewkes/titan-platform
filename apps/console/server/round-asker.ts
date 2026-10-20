/**
 * Who asked a decision round, and the one notice that tells them the owner answered. `decisions file` writes
 * `<round>/asker.json` beside the round.json it files; once `rounds.submit` has written `feedback.json`, the round
 * listener messages that seat through agent-chat and keeps `<round>/notified.json`, written once, so the seat
 * learns of the answer without polling the rounds dir. A failed send writes nothing and `sweep` retries it at start.
 *
 * The notice is fixed text built from the round id and the feedback path only. agent-chat delivers it from the human
 * seat, so nothing the filing seat wrote (prompts, option labels) is ever relayed under that provenance.
 */
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { messageAgent } from "@titan-design/agent-dispatch";
import { FEEDBACK_FILE, MAX_ROUND_BYTES, OPEN_FLAGS, readCapped } from "./rounds.js";

export const ASKER_FILE = "asker.json";
const NOTIFIED_FILE = "notified.json";
export const ASKER_SCHEMA_ID = "titan-console/asker@1";
const NOTIFIED_SCHEMA_ID = "titan-console/notified@1";
/** agent-chat's peer name rule; an initiative slug follows the same shape. */
export const SEAT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const AskerRecord = z.strictObject({
  schema: z.literal(ASKER_SCHEMA_ID),
  seat: z.string().regex(SEAT_NAME),
  initiative: z.string().regex(SEAT_NAME).nullable(),
  filedAt: z.iso.datetime(),
});
export type AskerRecord = z.infer<typeof AskerRecord>;

/** Sends `text` to the live seat `seat`; rejects when it cannot be delivered. */
export type SeatNotifier = (seat: string, text: string) => Promise<void>;

const SEND_TIMEOUT_MS = 10_000;

/** `agent-chat debug send`, through agent-dispatch; a seat that is not live rejects, so the sweep tries again. */
export const seatNotifier =
  (agentChatBin: string): SeatNotifier =>
  (seat, text) =>
    messageAgent(agentChatBin, seat, text, SEND_TIMEOUT_MS);

const errnoOf = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

/** False when the file already exists; `wx` also refuses a symlink planted at the name. */
export async function writeJsonOnce(file: string, value: unknown): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if (errnoOf(error) === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  return true;
}

const exists = (file: string): Promise<boolean> =>
  open(file, OPEN_FLAGS).then(
    (handle) => handle.close().then(() => true),
    (error: unknown) => errnoOf(error) !== "ENOENT",
  );

/** Undefined for every way `asker.json` can be missing or wrong; never throws. */
export async function readAsker(roundDir: string): Promise<AskerRecord | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path.join(roundDir, ASKER_FILE), OPEN_FLAGS);
  } catch {
    return undefined;
  }
  try {
    const bytes = (await handle.stat()).isFile() ? await readCapped(handle, MAX_ROUND_BYTES) : null;
    const parsed = bytes === null ? undefined : AskerRecord.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed?.success ? parsed.data : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export const answerNotice = (roundId: string, feedbackPath: string): string =>
  `titan-console: the owner answered your decision round ${roundId}. The answers are in ${feedbackPath} (titan-review/feedback@1).`;

/** Messages the asking seat once per answered round; a round with no asker, or no answer yet, is left alone. */
export async function notifyAsker(roundsDir: string, roundId: string, notify: SeatNotifier, now: Date): Promise<void> {
  const dir = path.join(roundsDir, roundId);
  const feedback = path.join(dir, FEEDBACK_FILE);
  if ((await exists(path.join(dir, NOTIFIED_FILE))) || !(await exists(feedback))) return;
  const asker = await readAsker(dir);
  if (asker === undefined) return;
  await notify(asker.seat, answerNotice(roundId, feedback));
  await writeJsonOnce(path.join(dir, NOTIFIED_FILE), { schema: NOTIFIED_SCHEMA_ID, seat: asker.seat, at: now.toISOString() });
}
