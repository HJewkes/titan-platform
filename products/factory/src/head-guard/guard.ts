import type { Db } from "@titan-design/store-sqlite";
import { advances, classifyHeadRead, type Ancestry, type HeadClass, type StoredHead, type Unavailable } from "./classify.js";
import { advanceEpoch, readEpoch, type PrKey } from "./epoch-store.js";

export type { Ancestry, HeadClass, Unavailable } from "./classify.js";

/** Waits between the re-reads of a stale head: five tries over two minutes. */
export const RETRY_DELAYS_MS: readonly number[] = [8_000, 16_000, 24_000, 32_000, 40_000];

/** Every read is injected; the guard never touches the network, so none can run inside the epoch transaction. */
export interface GuardDeps {
  db: Db;
  readHead(key: PrKey): Promise<string | Unavailable>;
  ancestry(key: PrKey, base: string, head: string): Promise<Ancestry | Unavailable>;
  lsRemote(key: PrKey): Promise<string | null | Unavailable>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

type GuardOutcome =
  | { outcome: "same"; head: string; epoch: number }
  | { outcome: "confirmed"; head: string; epoch: number }
  /** Replica lag outlasted the tries; a wait that self-clears, with nothing moved. */
  | { outcome: "unknown" };

type Retry = { outcome: "stale" } | { outcome: "lost" };
type Attempt = GuardOutcome | Unavailable | Retry;

const isUnavailable = (value: string | null | Unavailable | Attempt): value is Unavailable => typeof value === "object" && value !== null && "kind" in value;

/** One ref's second opinions: GitHub's compare against the stored sha, and `ls-remote` on the ref. */
export interface RefReads {
  ancestry(base: string, head: string): Promise<Ancestry | Unavailable>;
  lsRemote(): Promise<string | null | Unavailable>;
  now(): Date;
}

async function classifyRead(reads: RefReads, stored: StoredHead | undefined, read: string): Promise<HeadClass> {
  const ancestry = stored === undefined || stored.head === read ? undefined : await reads.ancestry(stored.head, read);
  const first = classifyHeadRead({ stored, read, ancestry, now: reads.now().getTime() });
  if (first.kind !== "suspect") return first;
  const lsRemote = await reads.lsRemote();
  return classifyHeadRead({ stored, read, ancestry, lsRemote, now: reads.now().getTime() });
}

/**
 * A branch keeps no epoch: its tip is classified against the last tip read, as a head against its stored one, and the
 * answer moves nothing. `from` null is a first read, which only `ls-remote` can confirm.
 */
export function classifyTipRead(reads: RefReads, from: string | null, read: string): Promise<HeadClass> {
  return classifyRead(reads, from === null ? undefined : { head: from, epoch: 0, earlierConfirmed: [] }, read);
}

function settle(deps: GuardStore, key: PrKey, stored: StoredHead | undefined, read: string, verdict: HeadClass): Attempt {
  if (verdict.kind === "same") return { outcome: "same", head: read, epoch: stored?.epoch ?? 0 };
  if (verdict.kind === "unavailable") return verdict;
  if (!advances(verdict)) return { outcome: "stale" };
  const moved = advanceEpoch(deps.db, { ...key, expectedEpoch: stored?.epoch ?? 0, head: read, by: verdict.by, at: deps.now().toISOString() });
  return moved.advanced ? { outcome: "confirmed", head: read, epoch: moved.epoch } : { outcome: "lost" };
}

/** The guard's reads and store, without the head read or the wait: what one try on a head already read needs. */
export type GuardStore = Pick<GuardDeps, "db" | "ancestry" | "lsRemote" | "now">;

type ReadHead = () => Promise<string | Unavailable>;

async function attempt(deps: GuardStore, key: PrKey, readHead: ReadHead): Promise<Attempt> {
  const read = await readHead();
  if (isUnavailable(read)) return read;
  const stored = readEpoch(deps.db, key);
  const verdict = await classifyRead({ ancestry: (base, head) => deps.ancestry(key, base, head), lsRemote: () => deps.lsRemote(key), now: deps.now }, stored, read);
  return settle(deps, key, stored, read, verdict);
}

/** A lost compare-and-set re-classifies once against the row that won; a second loss waits for the next try. */
async function attemptOnce(deps: GuardStore, key: PrKey, readHead: ReadHead): Promise<GuardOutcome | Unavailable | { outcome: "stale" }> {
  const first = await attempt(deps, key, readHead);
  if (isUnavailable(first) || first.outcome !== "lost") return first;
  const second = await attempt(deps, key, readHead);
  if (!isUnavailable(second) && second.outcome === "lost") return { outcome: "stale" };
  return second;
}

/**
 * Read the live head under the monotonic rule. Only a confirmed read moves the epoch; a stale one is re-read on the
 * retry schedule, then answered `unknown`. `Unavailable` is returned as is and counts no try.
 */
export async function guardedHeadRead(deps: GuardDeps, key: PrKey): Promise<GuardOutcome | Unavailable> {
  for (const delay of [0, ...RETRY_DELAYS_MS]) {
    if (delay > 0) await deps.sleep(delay);
    const result = await attemptOnce(deps, key, () => deps.readHead(key));
    if (isUnavailable(result) || result.outcome !== "stale") return result;
  }
  return { outcome: "unknown" };
}

/**
 * One try on a head another read already returned, as the reconciler's snapshot does. A stale answer is final: re-reading
 * the same head would answer the same, so the caller's next pass is the retry.
 */
export function guardReadHead(deps: GuardStore, key: PrKey, read: string): Promise<GuardOutcome | Unavailable | { outcome: "stale" }> {
  return attemptOnce(deps, key, () => Promise.resolve(read));
}
