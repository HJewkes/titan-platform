import type { ActiveWork, ReadName } from "./active-work.js";
import type { Invalidation } from "./invalidation.js";
import { cachedReads, stableJson, type CacheTimes } from "./read-cache.js";

/**
 * Five seconds bounds how long a hand-edited task file can go unseen, since a direct edit sends no event; two minutes is how
 * long a down daemon's last answer is still served.
 */
const ACTIVE_WORK_TIMES: CacheTimes = { freshMs: 5_000, staleMs: 120_000 };
const MAX_KEYS = 256;

/** `artifact.status` runs `gh` live, `search` and `note.read` are one-off; everything else is a whole-tree read worth sharing. */
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

/** Concurrent identical reads share one upstream call, and a recent answer is served while one refresh runs behind it. */
export function cachedActiveWork(inner: ActiveWork, invalidation?: Invalidation, now?: () => number, times: CacheTimes = ACTIVE_WORK_TIMES): ActiveWork {
  const cache = cachedReads<Call, unknown>(({ command, args }) => inner.read(command, args), times, {
    keyOf: ({ command, args }) => `${command} ${stableJson(args)}`,
    maxKeys: MAX_KEYS,
    ...(now !== undefined && { now }),
  });
  invalidation?.on("active-work", cache.invalidate);
  return {
    read: ((command: ReadName, args: Record<string, unknown> = {}) =>
      CACHED.has(command) ? cache.read({ command, args }) : inner.read(command, args)) as ActiveWork["read"],
  };
}
