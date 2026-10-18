/**
 * The factory's outcome for a Ship or Send back answer, as `rounds.get` shows it: the listener writes
 * `answer.json` once (`listeners.ts`), and this reads it back. Another process owns the file, so a
 * symlink, a non-regular file, an oversized or unparseable one, or one of another schema is no
 * answer at all; the round still loads and nothing is logged per request.
 */
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const ANSWER_FILE = "answer.json";
export const ANSWER_SCHEMA_ID = "titan-console/gate-answer@1";
const MAX_ANSWER_BYTES = 64 * 1024;
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export const gateAnswer = z.object({
  status: z.enum(["resolved", "already", "moved", "gone", "refused", "off"]),
  at: z.string(),
  /** Which answer a resolved outcome applied. */
  choice: z.enum(["merge", "send-back", "accept-set"]).optional(),
  currentHead: z.string().optional(),
  reason: z.string().optional(),
});
export type GateAnswer = z.infer<typeof gateAnswer>;

const record = z.object({
  schema: z.literal(ANSWER_SCHEMA_ID),
  at: z.string(),
  outcome: z.looseObject({
    status: gateAnswer.shape.status,
    choice: z.string().optional(),
    currentHead: z.string().nullish(),
    reason: z.string().optional(),
  }),
});

function answerOf({ at, outcome }: z.infer<typeof record>): GateAnswer {
  const choice = outcome.status === "resolved" ? gateAnswer.shape.choice.safeParse(outcome.choice) : undefined;
  return {
    status: outcome.status,
    at,
    ...(choice?.success && choice.data !== undefined && { choice: choice.data }),
    ...(outcome.status === "moved" && typeof outcome.currentHead === "string" && { currentHead: outcome.currentHead }),
    ...((outcome.status === "gone" || outcome.status === "refused") && outcome.reason !== undefined && { reason: outcome.reason }),
  };
}

async function readBytes(handle: FileHandle): Promise<Buffer | null> {
  const stats = await handle.stat();
  if (!stats.isFile() || stats.size > MAX_ANSWER_BYTES) return null;
  const buffer = Buffer.alloc(MAX_ANSWER_BYTES + 1);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  return bytesRead > MAX_ANSWER_BYTES ? null : buffer.subarray(0, bytesRead);
}

/** Undefined for every way the file can be missing or wrong; never throws. */
export async function readAnswer(roundDir: string): Promise<GateAnswer | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path.join(roundDir, ANSWER_FILE), OPEN_FLAGS);
  } catch {
    return undefined;
  }
  try {
    const bytes = await readBytes(handle);
    if (bytes === null) return undefined;
    const parsed = record.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed.success ? answerOf(parsed.data) : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
