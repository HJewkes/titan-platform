import { z } from "zod";
import { liveSource } from "@titan-design/rpc-client";
import { failure, unexpectedShape } from "./active-work.js";
import { readCommand } from "./owner-guard.js";

/**
 * The console does not depend on titan-factory, so it pins only the WatchRow fields it shows and
 * keeps the rest: Shepherd adds row fields often, and a new one must not fail the read.
 */
const watchRow = z
  .object({
    repo: z.string(),
    pr: z.number().int().nullable(),
    branch: z.string(),
    runId: z.string(),
    task: z.string(),
    phase: z.string(),
    headSha: z.string().nullable(),
    phaseSince: z.string(),
    nextAction: z.string(),
    pendingGate: z.object({ gateId: z.string(), stepId: z.string(), since: z.string() }).passthrough().nullable(),
    held: z.object({ reason: z.string() }).passthrough().nullable(),
    stalled: z.object({ reason: z.string() }).passthrough().nullable(),
  })
  .passthrough();

/** Entries stay `unknown` so a new entry kind upstream costs the page a fallback line, not the whole timeline. */
const prTimeline = z.object({ row: watchRow, entries: z.array(z.unknown()) });

const waitingGate = z
  .object({
    gateId: z.string(),
    stepId: z.string(),
    repo: z.string(),
    pr: z.number().int().nullable(),
    task: z.string(),
    since: z.string(),
    ageHours: z.number(),
  })
  .passthrough();

const waiting = z.object({ owner: z.array(waitingGate), seat: z.array(waitingGate) });

const LIST_STATES = ["active", "finished", "all"] as const;

export type WatchRow = z.infer<typeof watchRow>;
export type PrTimeline = z.infer<typeof prTimeline>;
export type Waiting = z.infer<typeof waiting>;
export type ListState = (typeof LIST_STATES)[number];

/** Each read rejects with an error that carries a sysexits `code` when Shepherd is down, refuses, or answers another shape. */
export interface ShepherdSource {
  list(state: ListState): Promise<WatchRow[]>;
  timeline(repo: string, pr: number): Promise<PrTimeline>;
  waiting(): Promise<Waiting>;
}

const READ_TIMEOUT_MS = 10_000;

/**
 * Calls Shepherd's read commands on titan-factory's loopback port. It sends only the client header
 * `liveSource` adds: never the browser's cookie or Host, and no token, so 7410 keeps its own guards.
 */
export function shepherdReader(port: number, timeoutMs: number = READ_TIMEOUT_MS): ShepherdSource {
  const source = liveSource({
    origin: `http://127.0.0.1:${port}`,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  });
  async function read<T>(command: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const envelope = await source.call(command, args);
    if (!envelope.ok) throw failure(`factory ${command}: ${envelope.error}`, envelope.code);
    const parsed = schema.safeParse(envelope.data);
    if (!parsed.success) throw unexpectedShape(`factory ${command}`);
    return parsed.data;
  }
  return {
    list: (state) => read("shepherd.list", { state }, z.array(watchRow)),
    timeline: (repo, pr) => read("shepherd.timeline", { repo, pr }, prTimeline),
    waiting: () => read("shepherd.waiting", {}, waiting),
  };
}

/** An allowlist of Shepherd's reads; no write (merge, hold, release, register) has a console command. */
export function shepherdCommands(shepherd: ShepherdSource) {
  return {
    "shepherd.list": readCommand({
      name: "shepherd.list",
      description: "Shepherd's watch list from titan-factory on loopback: every shepherded PR whose run is active (default), finished, or all",
      args: z.object({ state: z.enum(LIST_STATES).default("active") }),
      result: z.array(watchRow),
      run: ({ state }) => shepherd.list(state),
    }),
    "shepherd.timeline": readCommand({
      name: "shepherd.timeline",
      description: "One shepherded PR's watch row and every step, gate, hold and release its run recorded, oldest first",
      args: z.object({ repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be owner/repo"), pr: z.number().int().positive() }),
      result: prTimeline,
      run: ({ repo, pr }) => shepherd.timeline(repo, pr),
    }),
    "shepherd.waiting": readCommand({
      name: "shepherd.waiting",
      description: "Every pending Shepherd gate, oldest first: the owner's, then the seats'",
      args: z.object({}),
      result: waiting,
      run: () => shepherd.waiting(),
    }),
  };
}
