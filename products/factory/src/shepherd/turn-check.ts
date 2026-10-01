import type { AgentRow } from "@titan-design/agent-dispatch";
import { deadline } from "../workflows/deadline.js";
import type { Warmth } from "./warmth.js";

/** How long a woken agent has to start a turn before Shepherd asks it a second way. */
export const TURN_START_MS = 5 * 60_000;

/** True once the row's session shows an event written after `since` (epoch milliseconds). */
export type TurnSince = (row: AgentRow, since: number) => Promise<boolean>;

/** Reads the transcript tail the roster names; a missing or unreadable transcript shows no turn. */
export function transcriptTurnSince(readWarmth: (transcriptPath: string) => Promise<Warmth | undefined>): TurnSince {
  return async (row, since) => {
    if (!row.transcriptExists || row.transcriptPath === null || row.sessionId === "") return false;
    const warmth = await readWarmth(row.transcriptPath);
    return warmth !== undefined && warmth.lastEventAt > since;
  };
}

export interface TurnWatch {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs: number;
  timeoutMs: number;
  /** The latest row holding the agent's name, or undefined while the roster shows none. */
  row: () => Promise<AgentRow | undefined>;
  /** A pushed head proves the agent acted, and a closed PR leaves nothing to act on, whatever the transcript shows. */
  prMovedOn: () => Promise<boolean>;
  turnSince: TurnSince;
}

/** Polls until the agent starts a turn after `since` or the PR moves on; false once the deadline passes. */
export async function awaitTurn(watch: TurnWatch, since: number, signal: AbortSignal): Promise<boolean> {
  const clock = deadline(watch);
  for (;;) {
    if (await watch.prMovedOn()) return true;
    const row = await watch.row();
    if (row !== undefined && (await watch.turnSince(row, since).catch(() => false))) return true;
    if (clock.expired()) return false;
    await clock.sleep(watch.pollMs, signal);
  }
}
