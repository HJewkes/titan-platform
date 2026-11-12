import type { RefreshSummary } from './refresh.js';

export interface SchedulerStatus {
  running: boolean;
  pending: boolean;
  last: RefreshSummary | null;
  lastError: string | null;
  consecutiveErrors: number;
  /** Rounds skipped because another process held the refresh lock. */
  lockSkips: number;
  /** The gate is closed; stays true through a hold-cap pass. */
  held: boolean;
  holdReason: string | null;
  heldSince: string | null;
}

/** What the scheduler decided about a failed pass: which kind failed and how long until a retry. */
export interface PassFailure {
  kind: PassKind;
  backoffMs: number;
}

export interface SchedulerOptions {
  /** Called when a pass fails other than by lock contention, with the backoff already chosen for it. */
  onError?: (err: unknown, failure: PassFailure) => void;
  /** Called instead of `onError` when the refresh lock stayed held; the round retries with backoff. */
  onLockSkip?: (skips: number) => void;
  /** Least time between the starts of two runs; a burst inside it collapses to one trailing run. */
  minIntervalMs?: number;
  /** Least idle time after a pass ends before the next starts; defaults to `minIntervalMs`. */
  minIdleMs?: number;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Checked before each pass; while it holds, the pass stays pending and the gate is asked again. */
  gate?: () => Promise<GateDecision>;
  /** How long to wait between gate checks while held; defaults to 60 s. */
  gateRecheckMs?: number;
  /** Longest the gate may hold continuously before one pass is let through; defaults to 30 min. */
  maxHoldMs?: number;
  /** Called only when the gate flips between held and open, never on a recheck. */
  onHoldChange?: (held: boolean, reason?: string) => void;
  /** Whether changes wait that no pass has drained yet; a reader joining an indexed delta checks it (TP-893). */
  hasUndrained?: () => boolean;
}

/** A full pass walks the corpus; a delta pass indexes only what the watcher reported. */
export type PassKind = 'full' | 'delta';

export interface GateDecision {
  hold: boolean;
  reason?: string;
}

/** Lets a pass tell the scheduler its index writes are committed before it finishes. */
export type PassRun = (
  kind: PassKind,
  onIndexed: () => void,
  onLockWait: (waiting: boolean) => void,
) => Promise<RefreshSummary>;

export interface Execution {
  /** Resolves true when the pass succeeded. */
  done: Promise<boolean>;
  /** Resolves true once readers can read the pass's writes; false if it failed first. */
  indexed: Promise<boolean>;
  /** Set when the pass reports its writes committed, so its drain is already behind it. */
  pastIndexed: boolean;
  /** True while the pass waits on a refresh lock another process holds; it indexes nothing yet. */
  lockWaiting: boolean;
}
