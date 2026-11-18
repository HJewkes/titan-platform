import type { ActiveWork, ReadName, ReadResult, WriteName, WriteResult } from "./active-work.js";
import type { Invalidation } from "./invalidation.js";
import { cachedReads, stableJson, type CacheTimes } from "./read-cache.js";

/**
 * Five seconds bounds how long a hand-edited task file can go unseen, since a direct edit sends no event; two minutes is how
 * long a down daemon's last answer is still served.
 */
const ACTIVE_WORK_TIMES: CacheTimes = { freshMs: 5_000, staleMs: 120_000 };
/**
 * TP-6703: a whole-tree read costs seconds cold, so after an idle gap the owner's page is served the kept answer while one
 * refresh runs behind it; a failed refresh brings back the two-minute bound.
 */
const WHOLE_TREE_TIMES: CacheTimes = { ...ACTIVE_WORK_TIMES, keptMs: 30 * 60_000 };
const MAX_KEYS = 256;

/** `search` and `note.read` are one-off; everything else is a whole-tree read worth sharing. */
const CACHED: ReadonlySet<ReadName> = new Set<ReadName>([
  "list",
  "task.list",
  "inventory",
  "note.list",
  "source.list",
  "artifact.list",
  "source.read",
  "context.graph",
  "deliverable.list",
]);

interface Call {
  command: ReadName;
  args: Record<string, unknown>;
}

/** TP-6746: the portfolio reads every initiative's brief for its task prefix, so a cold brief is a fan-out of seconds. */
function isKeptLong({ command, args }: Call): boolean {
  if (command === "list" || command === "inventory") return true;
  if (command === "source.read") return args.path === "brief.md";
  return (command === "task.list" || command === "artifact.list") && args.all_initiatives === true;
}

function cacheWith(inner: ActiveWork, times: CacheTimes, invalidation: Invalidation | undefined, now: (() => number) | undefined) {
  return cachedReads<Call, unknown>(({ command, args }) => inner.read(command, args), times, {
    keyOf: ({ command, args }) => `${command} ${stableJson(args)}`,
    maxKeys: MAX_KEYS,
    ...(now !== undefined && { now }),
    onRefreshed: () => invalidation?.refreshed("active-work"),
  });
}

/**
 * Concurrent identical reads share one upstream call, and a recent answer is served while one refresh runs behind it.
 * An active-work frame marks every answer stale rather than dropping it: agents move the tree every few seconds, and a
 * whole-tree read takes longer than that, so a dropped answer was almost never replaced and every read waited upstream.
 */
export function cachedActiveWork(inner: ActiveWork, invalidation?: Invalidation, now?: () => number): ActiveWork {
  const wholeTree = cacheWith(inner, WHOLE_TREE_TIMES, invalidation, now);
  const scoped = cacheWith(inner, ACTIVE_WORK_TIMES, invalidation, now);
  const stale = (): void => {
    wholeTree.stale();
    scoped.stale();
  };
  invalidation?.on("active-work", stale);
  // The overload keeps the typed signature without asserting a cached `unknown` back to its result.
  function read<K extends ReadName>(command: K, args?: Record<string, unknown>): Promise<ReadResult<K>>;
  function read(command: ReadName, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!CACHED.has(command)) return inner.read(command, args);
    const call = { command, args };
    return (isKeptLong(call) ? wholeTree : scoped).read(call);
  }
  if (inner.write === undefined) return { read };
  const innerWrite = inner.write.bind(inner);
  // A write moves the tree, so the next read must not be served the answer from before it.
  async function write(command: "loop.tier", args: Record<string, unknown>): Promise<WriteResult<"loop.tier">>;
  async function write(command: "task.done" | "task.edit", args: Record<string, unknown>): Promise<WriteResult<"task.done">>;
  async function write(command: WriteName, args: Record<string, unknown>): Promise<WriteResult<WriteName>> {
    const answer = command === "loop.tier" ? await innerWrite(command, args) : await innerWrite(command, args);
    stale();
    return answer;
  }
  return { read, write };
}
