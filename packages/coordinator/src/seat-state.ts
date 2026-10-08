import { posix } from "node:path";
import { z } from "zod";
import { SEAT_EVENT_KINDS, seatEventSchema, type SeatEvent } from "./seat-events.js";

const count = z.number().int().nonnegative();

export const seatHoldSchema = z.object({ target: z.string(), reason: z.string() });
export const seatClaimSchema = z.object({
  owner: z.string(),
  worktree: z.string(),
  patterns: z.array(z.string()),
});
export const seatBackgroundSchema = z.object({ id: z.string(), command: z.string(), cwd: z.string() });
export const seatFoldErrorSchema = z.object({ index: count, kind: z.string(), message: z.string() });

export const seatStateSchema = z.object({
  generation: count,
  agents: z.array(z.string()),
  holds: z.array(seatHoldSchema),
  claims: z.array(seatClaimSchema),
  background: z.array(seatBackgroundSchema),
  authored: z.string(),
  errors: z.array(seatFoldErrorSchema),
  unknownEvents: count,
});

export type SeatState = z.infer<typeof seatStateSchema>;
export type SeatFoldError = z.infer<typeof seatFoldErrorSchema>;

export interface SeatFoldOptions {
  /** The host's $TMPDIR, passed in so the fold never reads the environment. */
  tmpdir?: string;
}

export const emptySeatState = (): SeatState => ({
  generation: 0,
  agents: [],
  holds: [],
  claims: [],
  background: [],
  authored: "",
  errors: [],
  unknownEvents: 0,
});

const TMP_ROOTS = ["/tmp", "/private/tmp"];

const isUnder = (path: string, root: string): boolean => {
  const base = root.length > 1 ? root.replace(/\/+$/, "") : root;
  return path === base || path.startsWith(`${base}/`);
};

// Whitespace and `=` split `--out=/tmp/x` too; only tokens with a slash can name a directory.
function pathsIn(command: string, cwd: string): string[] {
  const tokens = command.split(/[\s=]+/).map((t) => t.replace(/^['"]|['"]$/g, ""));
  const relative = (t: string) => (t.startsWith("/") ? t : posix.join(cwd, t));
  return [cwd, ...tokens.filter((t) => t.includes("/")).map(relative)].map((p) => posix.normalize(p));
}

/** The first path in a background command that sits in throwaway space, or undefined. */
export function scratchPathOf(
  command: string,
  cwd: string,
  options: SeatFoldOptions = {},
): string | undefined {
  const roots = options.tmpdir ? [...TMP_ROOTS, options.tmpdir] : TMP_ROOTS;
  return pathsIn(command, cwd).find(
    (p) => roots.some((root) => isUnder(p, root)) || p.split("/").includes("scratchpad"),
  );
}

const without = <T>(items: T[], drop: (item: T) => boolean): T[] => items.filter((item) => !drop(item));

type BackgroundEvent = Extract<SeatEvent, { kind: "background" }>;

function applyBackground(
  state: SeatState,
  event: BackgroundEvent,
  index: number,
  options: SeatFoldOptions,
): SeatState {
  const scratch = scratchPathOf(event.command, event.cwd, options);
  if (scratch !== undefined) {
    const message = `background ${event.id} refused: ${scratch} is temporary or scratch space`;
    return { ...state, errors: [...state.errors, { index, kind: event.kind, message }] };
  }
  const { id, command, cwd } = event;
  return { ...state, background: [...without(state.background, (b) => b.id === id), { id, command, cwd }] };
}

function applyEvent(state: SeatState, event: SeatEvent, index: number, options: SeatFoldOptions): SeatState {
  switch (event.kind) {
    case "spawn":
      return { ...state, agents: [...without(state.agents, (a) => a === event.agent), event.agent] };
    case "retire":
      return { ...state, agents: without(state.agents, (a) => a === event.agent) };
    case "teleport":
      return { ...state, generation: state.generation + 1 };
    case "claim": {
      const { owner, worktree, patterns } = event;
      const others = without(state.claims, (c) => c.worktree === worktree);
      return { ...state, claims: [...others, { owner, worktree, patterns }] };
    }
    case "release":
      return { ...state, claims: without(state.claims, (c) => c.worktree === event.worktree) };
    case "hold": {
      const { target, reason } = event;
      return { ...state, holds: [...without(state.holds, (h) => h.target === target), { target, reason }] };
    }
    case "unhold":
      return { ...state, holds: without(state.holds, (h) => h.target === event.target) };
    case "background":
      return applyBackground(state, event, index, options);
    case "background-stop":
      return { ...state, background: without(state.background, (b) => b.id === event.id) };
    case "authored":
      return { ...state, authored: event.text };
  }
}

const kindOf = (raw: unknown): string =>
  typeof raw === "object" && raw !== null && typeof (raw as { kind?: unknown }).kind === "string"
    ? (raw as { kind: string }).kind
    : "";

function step(state: SeatState, raw: unknown, index: number, options: SeatFoldOptions): SeatState {
  const kind = kindOf(raw);
  if (!SEAT_EVENT_KINDS.includes(kind)) return { ...state, unknownEvents: state.unknownEvents + 1 };
  const parsed = seatEventSchema.safeParse(raw);
  if (parsed.success) return applyEvent(state, parsed.data, index, options);
  const message = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  return { ...state, errors: [...state.errors, { index, kind, message }] };
}

/**
 * Folds a seat's event log into its state. Pure: no clock, fs, env or network. It never throws:
 * an unknown kind is counted and a malformed or refused event is recorded in `errors`.
 */
export function foldSeatEvents(
  events: readonly unknown[],
  options: SeatFoldOptions = {},
  from: SeatState = emptySeatState(),
): SeatState {
  return events.reduce<SeatState>((state, raw, index) => step(state, raw, index, options), from);
}
