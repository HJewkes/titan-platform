import type { Db } from "@titan-design/store-sqlite";
import { advances, classifyHeadRead, type Ancestry, type HeadClass, type StoredHead, type Unavailable } from "./classify.js";
import { advanceEpoch, readEpoch, type PrKey } from "./epoch-store.js";

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

export type GuardOutcome =
  | { outcome: "same"; head: string; epoch: number }
  | { outcome: "confirmed"; head: string; epoch: number }
  /** Replica lag outlasted the tries; a wait that self-clears, with nothing moved. */
  | { outcome: "unknown" };

type Retry = { outcome: "stale" } | { outcome: "lost" };
type Attempt = GuardOutcome | Unavailable | Retry;

const isUnavailable = (value: unknown): value is Unavailable => typeof value === "object" && value !== null && (value as Unavailable).kind === "unavailable";

async function classifyRead(deps: GuardDeps, key: PrKey, stored: StoredHead | undefined, read: string): Promise<HeadClass> {
  const ancestry = stored === undefined || stored.head === read ? undefined : await deps.ancestry(key, stored.head, read);
  const first = classifyHeadRead({ stored, read, ancestry, now: deps.now().getTime() });
  if (first.kind !== "suspect") return first;
  const lsRemote = await deps.lsRemote(key);
  return classifyHeadRead({ stored, read, ancestry, lsRemote, now: deps.now().getTime() });
}

function settle(deps: GuardDeps, key: PrKey, stored: StoredHead | undefined, read: string, verdict: HeadClass): Attempt {
  if (verdict.kind === "same") return { outcome: "same", head: read, epoch: stored?.epoch ?? 0 };
  if (verdict.kind === "unavailable") return verdict;
  if (!advances(verdict)) return { outcome: "stale" };
  const moved = advanceEpoch(deps.db, { ...key, expectedEpoch: stored?.epoch ?? 0, head: read, by: verdict.by, at: deps.now().toISOString() });
  return moved.advanced ? { outcome: "confirmed", head: read, epoch: moved.epoch } : { outcome: "lost" };
}

async function attempt(deps: GuardDeps, key: PrKey): Promise<Attempt> {
  const read = await deps.readHead(key);
  if (isUnavailable(read)) return read;
  const stored = readEpoch(deps.db, key);
  const verdict = await classifyRead(deps, key, stored, read);
  return settle(deps, key, stored, read, verdict);
}

/** A lost compare-and-set re-classifies once against the row that won; a second loss waits for the next try. */
async function attemptOnce(deps: GuardDeps, key: PrKey): Promise<GuardOutcome | Unavailable | { outcome: "stale" }> {
  const first = await attempt(deps, key);
  if (isUnavailable(first) || first.outcome !== "lost") return first;
  const second = await attempt(deps, key);
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
    const result = await attemptOnce(deps, key);
    if (isUnavailable(result) || result.outcome !== "stale") return result;
  }
  return { outcome: "unknown" };
}
