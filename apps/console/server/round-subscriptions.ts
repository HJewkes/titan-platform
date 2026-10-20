/**
 * Which seats want to hear that the owner answered a round. `titan-console rounds subscribe` keeps one file per seat
 * and target in `<state>/round-subscriptions/`, so subscriptions outlive the console and a teleport successor that keeps
 * its agent-chat name keeps them. A target is a round id, a unit, a glob over either (`*`, `?`), or `owner/repo#N`,
 * which names every round whose Ship question merges that PR. Targets are matched when an answer lands, so a glob or
 * PR target also covers rounds imported after it was made; a subscription hears only answers written after it.
 *
 * `operator-since.json` is when the console first kept subscriptions. A round answered with no asker and no subscriber
 * goes to tp-operator, but only from then on, so the first start does not page it for every answer already on disk.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { SEAT_NAME } from "./round-notice-transport.js";
import { readStateJson, writeJsonOnce } from "./state-file.js";

const SUBSCRIPTION_SCHEMA_ID = "titan-console/round-subscription@1";
const SINCE_SCHEMA_ID = "titan-console/operator-since@1";
const SUBSCRIPTION_PREFIX = "sub-";
const SINCE_FILE = "operator-since.json";
/** The seat told of an answer no one asked for or subscribed to. */
export const UNCLAIMED_SEAT = "tp-operator";

const ROUND_TARGET = /^[A-Za-z0-9_*?-]{1,64}$/;
const PR_TARGET = /^([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})#([1-9][0-9]{0,9})$/;

export const Subscription = z.strictObject({
  schema: z.literal(SUBSCRIPTION_SCHEMA_ID),
  seat: z.string().regex(SEAT_NAME),
  target: z.string(),
  at: z.iso.datetime(),
});
export type Subscription = z.infer<typeof Subscription>;

const OperatorSince = z.strictObject({ schema: z.literal(SINCE_SCHEMA_ID), at: z.iso.datetime() });

/** What a target is matched against: the round id, its unit, and the PRs its Ship questions merge. */
export interface RoundFacts {
  id: string;
  unit: string | null;
  prs: { repo: string; pr: number }[];
}

export const subscriptionsDirOf = (stateDir: string): string => path.join(stateDir, "round-subscriptions");

/** GitHub names are case-insensitive, so a PR target is kept lower-cased; null when `raw` is no target. */
export function normalTarget(raw: string): string | null {
  if (ROUND_TARGET.test(raw)) return raw;
  const pr = PR_TARGET.exec(raw);
  return pr === null ? null : `${pr[1]?.toLowerCase()}#${pr[2]}`;
}

const globRegex = (glob: string): RegExp => new RegExp(`^${glob.replaceAll("*", ".*").replaceAll("?", ".")}$`);

export function targetMatches(target: string, round: RoundFacts): boolean {
  const pr = PR_TARGET.exec(target);
  if (pr !== null) return round.prs.some((merge) => `${merge.repo.toLowerCase()}#${merge.pr}` === `${pr[1]}#${pr[2]}`);
  const glob = globRegex(target);
  return glob.test(round.id) || (round.unit !== null && glob.test(round.unit));
}

const fileOf = (dir: string, seat: string, target: string): string =>
  path.join(dir, `${SUBSCRIPTION_PREFIX}${seat}-${createHash("sha256").update(target).digest("hex").slice(0, 16)}.json`);

function checkedTarget(raw: string): string {
  const target = normalTarget(raw);
  if (target === null) throw failure(`"${raw}" is not a round id, unit glob or owner/repo#N`, EXIT.USAGE);
  return target;
}

function checkedTargets(seat: string, targets: readonly string[]): string[] {
  if (!SEAT_NAME.test(seat)) throw failure(`seat "${seat}" is not an agent-chat name (lowercase letters, digits and dashes)`, EXIT.USAGE);
  if (targets.length === 0) throw failure("name at least one round id, unit glob or owner/repo#N", EXIT.USAGE);
  return targets.map(checkedTarget);
}

interface SubscribeOutcome {
  target: string;
  /** False when the seat already held this subscription; the first one, and its time, are kept. */
  created: boolean;
}

export async function subscribe(dir: string, seat: string, targets: readonly string[], now = new Date()): Promise<SubscribeOutcome[]> {
  const checked = checkedTargets(seat, targets);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const outcomes: SubscribeOutcome[] = [];
  for (const target of checked) {
    const record: Subscription = { schema: SUBSCRIPTION_SCHEMA_ID, seat, target, at: now.toISOString() };
    outcomes.push({ target, created: await writeJsonOnce(fileOf(dir, seat, target), record) });
  }
  return outcomes;
}

interface UnsubscribeOutcome {
  target: string;
  removed: boolean;
}

export async function unsubscribe(dir: string, seat: string, targets: readonly string[]): Promise<UnsubscribeOutcome[]> {
  const outcomes: UnsubscribeOutcome[] = [];
  for (const target of checkedTargets(seat, targets)) {
    const file = fileOf(dir, seat, target);
    const held = (await readStateJson(file, Subscription)) !== undefined;
    if (held) await rm(file);
    outcomes.push({ target, removed: held });
  }
  return outcomes;
}

/** Every well-formed subscription, oldest first; an unreadable file is skipped, never fatal. */
export async function listSubscriptions(dir: string): Promise<Subscription[]> {
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.startsWith(SUBSCRIPTION_PREFIX) && name.endsWith(".json"));
  const records = await Promise.all(names.map((name) => readStateJson(path.join(dir, name), Subscription)));
  return records.filter((record) => record !== undefined).sort((a, b) => a.at.localeCompare(b.at) || a.seat.localeCompare(b.seat));
}

/** Records, once, the moment answers with no subscriber start going to tp-operator. */
export async function markOperatorSince(dir: string, now: Date): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeJsonOnce(path.join(dir, SINCE_FILE), { schema: SINCE_SCHEMA_ID, at: now.toISOString() });
}

export async function operatorSince(dir: string): Promise<Date | undefined> {
  const record = await readStateJson(path.join(dir, SINCE_FILE), OperatorSince);
  return record === undefined ? undefined : new Date(record.at);
}
