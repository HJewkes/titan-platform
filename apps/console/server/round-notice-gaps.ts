/**
 * Round notices the start-up sweep retried and still could not send (TP-3756). A live send that fails is left to the
 * sweep and leaves no trace; a sweep send that fails keeps `<round>/notice-failed-<seat>.json`, which the inbox shows
 * as a read-only derived row so the owner knows that seat never heard of the answer. The next send that reaches the
 * seat removes the file, and the row with it.
 */
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { derivedRow, type DerivedRow } from "./inbox-derived.js";
import { ROUND_ID } from "./rounds.js";
import { readStateJson, writeJsonOnce } from "./state-file.js";

const FAILED_PREFIX = "notice-failed-";
const FAILED_SCHEMA_ID = "titan-console/notice-failed@1";
/** The sweep is the retry, so a notice it could not send is an exception from the moment it failed. */
const MISSED_NOTICE_AFTER_MS = 0;

const NoticeFailed = z.strictObject({ schema: z.literal(FAILED_SCHEMA_ID), round: z.string(), seat: z.string(), error: z.string(), at: z.iso.datetime() });
type NoticeFailed = z.infer<typeof NoticeFailed>;

const failedFile = (roundDir: string, seat: string): string => path.join(roundDir, `${FAILED_PREFIX}${seat}.json`);

/** Replaces any earlier record, so the row names the latest error. */
export async function recordNoticeFailure(roundDir: string, failed: Omit<NoticeFailed, "schema">): Promise<void> {
  const file = failedFile(roundDir, failed.seat);
  await rm(file, { force: true });
  await writeJsonOnce(file, { schema: FAILED_SCHEMA_ID, ...failed });
}

export const clearNoticeFailure = (roundDir: string, seat: string): Promise<void> => rm(failedFile(roundDir, seat), { force: true });

async function roundFailures(roundDir: string): Promise<NoticeFailed[]> {
  const names = (await readdir(roundDir).catch(() => [])).filter((name) => name.startsWith(FAILED_PREFIX) && name.endsWith(".json"));
  const records = await Promise.all(names.map((name) => readStateJson(path.join(roundDir, name), NoticeFailed)));
  return records.filter((record) => record !== undefined);
}

function missedNoticeRow({ round, seat, error, at }: NoticeFailed, now: number): DerivedRow {
  return derivedRow(
    {
      id: `derived:missed-notice:${round}:${seat}`,
      kind: "missed-notice",
      summary: `${seat} was not told the owner answered round ${round}`,
      evidence: { observed: `notice failed after the start-up sweep's retry: ${error}`, source: `round notice ${round} to ${seat}`, at },
      threshold: { name: "a round notice the start-up sweep could not send", limitMs: MISSED_NOTICE_AFTER_MS },
      link: `#/rounds/${encodeURIComponent(round)}`,
    },
    now,
  );
}

/** One row per round and seat whose last sweep send failed and no send has reached since. */
export async function missedNoticeRows(roundsDir: string, now: number): Promise<DerivedRow[]> {
  const rounds = (await readdir(roundsDir).catch(() => [])).filter((name) => ROUND_ID.test(name));
  const failures = await Promise.all(rounds.map((round) => roundFailures(path.join(roundsDir, round))));
  return failures.flat().map((failed) => missedNoticeRow(failed, now));
}
