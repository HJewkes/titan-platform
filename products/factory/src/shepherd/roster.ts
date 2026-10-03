import { listAgents, type AgentRow } from "@titan-design/agent-dispatch";

/** How long one `agent ls --json` answers every caller in the serve process. */
export const ROSTER_TTL_MS = 12_000;
export const ROSTER_TIMEOUT_MS = 30_000;

/** `unknown` carries the read's own error, so a caller can still tell a broker that is down from a refusal. */
export type RosterRead = { kind: "known"; rows: readonly AgentRow[] } | { kind: "unknown"; error: unknown };

export interface RosterReader {
  read(): Promise<RosterRead>;
  /** The rows of a known read; an unknown read throws its error, so it is never mistaken for an empty roster. */
  rows(): Promise<readonly AgentRow[]>;
  /** Drops the cached rows and any read in flight, so the next caller sees the broker after a spawn, resume or retire. */
  invalidate(): void;
}

export interface RosterReaderOptions {
  now?: () => number;
  ttlMs?: number;
}

/** Concurrent callers share one read in flight; a known read is reused for `ttlMs`, and a failed one is never cached. */
export function createRosterReader(fetchRows: () => Promise<readonly AgentRow[]>, options: RosterReaderOptions = {}): RosterReader {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? ROSTER_TTL_MS;
  let cached: { rows: readonly AgentRow[]; at: number } | undefined;
  let inFlight: Promise<RosterRead> | undefined;
  let generation = 0;

  const start = (): Promise<RosterRead> => {
    const mine = generation;
    const at = now();
    const settle = (read: RosterRead): RosterRead => {
      if (mine !== generation) return read;
      inFlight = undefined;
      if (read.kind === "known") cached = { rows: read.rows, at };
      return read;
    };
    return fetchRows().then((rows): RosterRead => settle({ kind: "known", rows }), (error: unknown) => settle({ kind: "unknown", error }));
  };

  const read = (): Promise<RosterRead> => {
    if (cached !== undefined && now() - cached.at < ttlMs) return Promise.resolve({ kind: "known", rows: cached.rows });
    inFlight ??= start();
    return inFlight;
  };

  return {
    read,
    rows: async () => {
      const result = await read();
      if (result.kind === "unknown") throw result.error;
      return result.rows;
    },
    invalidate: () => {
      generation += 1;
      cached = undefined;
      inFlight = undefined;
    },
  };
}

/** The serve process's reader over `agent-chat agent ls --json`. */
export function agentChatRoster(agentChatBin: string, options: RosterReaderOptions & { timeoutMs?: number } = {}): RosterReader {
  const timeoutMs = options.timeoutMs ?? ROSTER_TIMEOUT_MS;
  return createRosterReader(async () => listAgents(agentChatBin, timeoutMs), options);
}

/** Runs a mutation of the broker's roster, then invalidates the reader whether it landed or not, since a timeout may still have landed. */
export async function mutating<T>(roster: RosterReader, change: () => Promise<T>): Promise<T> {
  try {
    return await change();
  } finally {
    roster.invalidate();
  }
}
