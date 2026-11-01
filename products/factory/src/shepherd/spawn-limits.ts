/**
 * The machine limits a seat's own spawn passes (charter section 4, enforced by agent-chat in src/agents/seats/stops.ts and
 * src/agents/machine-guard.ts). They are copied here because the factory cannot call the broker's gate; unify them when agent-chat exposes it.
 */
export interface SpawnLimits {
  /** No new dispatch at a load5 above this. */
  load5: number;
  /** No new dispatch at a build-capable load5 above this; a review started in the last five minutes adds `reviewLoad` to the reading. */
  buildLoad5: number;
  /** The memory pressure level (1 normal, 2 warn, 4 critical) at which nothing starts. */
  pressureLevel: number;
  /** No new dispatch with less than this percent of memory free. */
  freeMemoryPct: number;
  /** Without headroom, the least interval between two factory spawns; 0 leaves load as the only limiter. */
  windowMs: number;
  /** The interval between admits while the machine has headroom (see `hasHeadroom`); 0 means none. */
  headroomIntervalMs: number;
  /** Headroom needs fewer unabsorbed reviews than this. */
  headroomReviews: number;
  /** The cores one unabsorbed review adds to the load readings it is compared with. */
  reviewLoad: number;
  /** No new dispatch while fewer cores than this stay idle: the cores less load1 less the unabsorbed reviews' `reviewLoad`. */
  minIdleCores: number;
  /** No review starts with fewer free bytes than this on the filesystem that holds review checkouts. */
  reviewMinFreeBytes: number;
  /** No review starts with fewer free inodes than this percent of that filesystem's, or than twice the last checkout's. */
  reviewMinFreeInodesPct: number;
  /** No review starts while this many reviewers run. */
  maxConcurrentReviews: number;
}

export const DEFAULT_SPAWN_LIMITS: SpawnLimits = {
  load5: 28,
  buildLoad5: 20,
  pressureLevel: 2,
  freeMemoryPct: 20,
  windowMs: 0,
  headroomIntervalMs: 0,
  headroomReviews: 4,
  // A 2026-10-29 sample of a 48-core host put every claude process together at ~0.3 core, each at 1-3% CPU, with reviewers running no tests; 0.05 covers one with margin.
  reviewLoad: 0.05,
  // A reviewer needs well under a core, so one idle core admits it; a host that also runs suites raises this (one vitest suite took ~7.5 cores in that sample).
  minIdleCores: 1,
  reviewMinFreeBytes: 5 * 1024 ** 3,
  reviewMinFreeInodesPct: 15,
  maxConcurrentReviews: 3,
};

/** A reading the machine would not give is absent, and the limit it feeds is not applied. */
export interface MachineReadings {
  load5: number;
  /** The one-minute load average, read as the cores busy now; with `cores` it gives the measured headroom. */
  load1?: number;
  /** The cores this process may use (`os.availableParallelism()`). */
  cores?: number;
  pressureLevel?: number;
  freeMemoryPct?: number;
}
