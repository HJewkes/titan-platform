import type { TurnState } from "./turn-state.js";
import { idleBeatStep, type IdleBeatPolicy } from "./idle-beat.js";

export interface IdleBeatPorts {
  readTurn: () => TurnState;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** True when the seat's stop condition holds; asked only when a beat is due. */
  stopHolds: () => boolean;
  /** False once the session that armed the beat has exited, since nobody is left to wake. */
  sessionAlive: () => boolean;
}

export type IdleBeatOutcome =
  | { kind: "beat"; reason: "idle" | "max"; idleMs: number }
  | { kind: "stopped" }
  | { kind: "session-gone" };

/**
 * Polls until a beat is due, then returns once. One wake per run: the session re-arms on the
 * wake it gets, so the beat needs no state file and nothing to survive a compaction.
 */
export async function waitForIdleBeat(policy: IdleBeatPolicy, pollMs: number, ports: IdleBeatPorts): Promise<IdleBeatOutcome> {
  const armedAtMs = ports.now();
  for (;;) {
    if (!ports.sessionAlive()) return { kind: "session-gone" };
    const step = idleBeatStep({ turn: ports.readTurn(), nowMs: ports.now(), armedAtMs, policy });
    if (step.kind === "beat") return ports.stopHolds() ? { kind: "stopped" } : step;
    await ports.sleep(pollMs);
  }
}
