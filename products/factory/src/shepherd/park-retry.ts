import type { RosterReader } from "./roster.js";

/** A roster read is shared and cached, so a minute between looks costs one `agent ls` per minute across every waiting park. */
const PARK_RETRY_POLL_MS = 60_000;
/** A run held for review can keep its implementer live for a day or more; past two, the seat is told instead. */
const PARK_RETRY_GIVE_UP_MS = 48 * 3_600_000;

/** One park attempt for a name: `live` means the agent still runs and the attempt is worth repeating after it exits. */
export type ParkAttempt = { done: true; detail: string; parked: boolean } | { done: false };

export interface LiveRetryDeps {
  attempt(name: string): ParkAttempt;
  /** The agent's presence, or undefined when the roster cannot be read or holds no such name. */
  presence(name: string): Promise<string | undefined>;
  wait(ms: number): Promise<void>;
  now(): number;
  pollMs?: number;
  giveUpMs?: number;
}

/** What the retry ends with; `parked: false` is a refusal or a give-up the caller tells the seat about. */
interface RetrySettled {
  agent: string;
  parked: boolean;
  detail: string;
}

export interface LiveRetry {
  /** Waits for the agent to exit, then parks it; a second arm for an agent already waited on is ignored. */
  arm(agent: string, settle: (settled: RetrySettled) => Promise<void>): Promise<void> | undefined;
}

const STILL_RUNNING: ReadonlySet<string> = new Set(["live", "exiting"]);

/**
 * In-process on purpose: the step that refused records the refusal, and `parkAtGreen` re-arms from that record whenever a
 * restart replays the run, so the wait survives a redeploy without a table of its own.
 */
export function liveRetry(deps: LiveRetryDeps): LiveRetry {
  const waiting = new Set<string>();
  const pollMs = deps.pollMs ?? PARK_RETRY_POLL_MS;
  const giveUpAt = (): number => deps.now() + (deps.giveUpMs ?? PARK_RETRY_GIVE_UP_MS);
  const untilExit = async (agent: string, settle: (settled: RetrySettled) => Promise<void>): Promise<void> => {
    const deadline = giveUpAt();
    try {
      for (;;) {
        await deps.wait(pollMs);
        if (deps.now() >= deadline) return await settle({ agent, parked: false, detail: `${agent} was still live ${Math.round((deps.giveUpMs ?? PARK_RETRY_GIVE_UP_MS) / 3_600_000)}h after its park was refused` });
        if (STILL_RUNNING.has((await deps.presence(agent)) ?? "")) continue;
        const attempt = deps.attempt(agent);
        if (attempt.done) return await settle({ agent, parked: attempt.parked, detail: attempt.detail });
      }
    } finally {
      waiting.delete(agent);
    }
  };
  return {
    arm: (agent, settle) => {
      if (waiting.has(agent)) return undefined;
      waiting.add(agent);
      return untilExit(agent, settle);
    },
  };
}

/** The newest row for the name, since a resumed agent keeps its name across generations. */
export function rosterPresence(roster: RosterReader): LiveRetryDeps["presence"] {
  return async (name) => {
    const read = await roster.read();
    if (read.kind === "unknown") return undefined;
    const rows = read.rows.filter((row) => row.name === name);
    return rows.reduce<(typeof rows)[number] | undefined>((best, row) => (best === undefined || row.generation >= best.generation ? row : best), undefined)?.presence;
  };
}

/** Unref'd, so a wait never holds the serve process open at shutdown. */
export const unrefWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());
