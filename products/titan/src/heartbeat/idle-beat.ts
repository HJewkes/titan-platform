import type { TurnState } from "@titan-design/session-read";

/**
 * The idle heartbeat's rule. A fixed cron wakes a session even when it has just finished a
 * turn, and re-reads its whole context for nothing. This beat is keyed on the session's own
 * idle time instead: it fires once the session has gone `idleMs` without a turn, and every
 * turn moves the idle clock, so a busy session is never woken. Pure: the clock and the turn
 * state arrive as arguments.
 */
export interface IdleBeatPolicy {
  idleMs: number;
  /** Fire anyway once this long has passed since arming, at the next moment the session is between turns. */
  maxMs?: number;
}

export interface IdleBeatInput {
  turn: TurnState;
  nowMs: number;
  armedAtMs: number;
  policy: IdleBeatPolicy;
}

export type IdleBeatStep = { kind: "wait" } | { kind: "beat"; reason: "idle" | "max"; idleMs: number };

const WAIT: IdleBeatStep = { kind: "wait" };

/** Only an `idle` reading can fire, so a session mid-turn, or one the reader cannot place, is never woken. */
export function idleBeatStep({ turn, nowMs, armedAtMs, policy }: IdleBeatInput): IdleBeatStep {
  if (turn.kind !== "idle") return WAIT;
  const idleMs = Math.max(0, nowMs - turn.sinceMs);
  if (idleMs >= policy.idleMs) return { kind: "beat", reason: "idle", idleMs };
  if (policy.maxMs !== undefined && nowMs - armedAtMs >= policy.maxMs) return { kind: "beat", reason: "max", idleMs };
  return WAIT;
}
