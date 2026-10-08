import { z } from "zod";
import { LAST_PROMPTS_SQL, SPAWNS_SQL, eventsDbCommand } from "./events-db.js";
import { stringField, type BrokerEntry } from "./liveness-broker.js";
import { DARK_MIN, darkGaps } from "./liveness-dark.js";
import { unreportedExitRows, type SpawnRecord } from "./liveness-exits.js";
import { PROMPT_STALE_MIN, stalePromptRows, type LastEventRecord } from "./liveness-prompts.js";
import { countMisses, routeFailureRows, routeMisses } from "./liveness-routes.js";
import { LIST_PRICE_CAVEAT, table } from "./render-text.js";

/** Where each section's findings come from: the command that re-reads them and the field it reads. */
export const LIVENESS_SOURCES = {
  registrations: {
    command: `grep -nE '"event":"(broker_started|registered|deregistered|agent_exited|teleport_started|teleport_completed|teleport_failed|teleport_aborted)"' <broker.log>`,
    field: "ts, event, name; cited as broker.log line numbers; a gap with a clean agent_exited (code 0, not inferred) and no teleport is a resume; a prompt before the last broker_started from an agent never registered after it is skipped",
  },
  routes: { command: `grep -n '"event":"route"' <broker.log>`, field: "to, delivered, recipients" },
  exits: { command: `grep -n '"event":"unreported-exit"' <broker.log>`, field: "agentId, name, spawner, lastAction" },
  spawns: { command: eventsDbCommand(SPAWNS_SQL), field: "events.msg_id (agent id), events.target (name), events.meta.profile" },
  prompts: {
    command: eventsDbCommand(LAST_PROMPTS_SQL),
    field: "events.ts, events.actor, events.meta.tool_name; a resolution row's events.ref; skipped after the actor's agent_exited or agent_retired (endEventId)",
  },
} as const;

export type LivenessSource = keyof typeof LIVENESS_SOURCES;

export interface LivenessInput {
  broker: readonly BrokerEntry[];
  spawns: readonly SpawnRecord[];
  lastEvents: readonly LastEventRecord[];
  /** Gaps still open and prompt ages are measured to here; later entries are ignored. */
  asOf: string;
  /** A finding is kept when it starts inside the window; a prompt from a live agent still unanswered at asOf is kept however old. */
  window?: { since?: string; until?: string };
  /** Keeps only findings about these names: the dark seat, route recipient, exiting agent or its spawner, prompting agent. */
  seats?: readonly string[];
}

const source = z.enum(["registrations", "routes", "exits", "spawns", "prompts"]);
const count = z.number().int().nonnegative();
const lines = z.array(count);

const darkRow = z.object({
  seat: z.string(),
  from: z.string(),
  to: z.string().nullable(),
  minutes: z.number(),
  teleport: z.boolean(),
  failedRoutes: count,
  partialRoutes: count,
  queuedRoutes: count,
  lines,
  routeLines: lines,
});

const exitRow = z.object({ at: z.string(), line: count, agentId: z.string(), name: z.string(), spawner: z.string(), lastAction: z.string(), spawnEventId: count.nullable() });

const promptRow = z.object({ agent: z.string(), at: z.string(), ageMin: z.number(), tool: z.string().nullable(), eventId: count, resolutionEventId: count.nullable() });

export const livenessSchema = z.object({
  asOf: z.string(),
  window: z.object({ since: z.string().optional(), until: z.string().optional() }),
  thresholds: z.object({ darkMin: z.number(), promptStaleMin: z.number() }),
  sources: z.record(source, z.object({ command: z.string(), field: z.string() })),
  darkSeats: z.object({ cites: z.array(source), withTeleport: count, withoutTeleport: count, rows: z.array(darkRow) }),
  routeFailures: z.object({
    cites: z.array(source),
    failed: count,
    partial: count,
    queued: count,
    rows: z.array(z.object({ recipient: z.string(), failed: count, partial: count, queued: count, first: z.string(), last: z.string(), lines })),
  }),
  unreportedExits: z.object({ cites: z.array(source), total: count, rows: z.array(z.object({ profile: z.string(), count, exits: z.array(exitRow) })) }),
  stalePrompts: z.object({ cites: z.array(source), rows: z.array(promptRow), resolvedRows: z.array(promptRow) }),
});

export type LivenessReport = z.infer<typeof livenessSchema>;

/** Seats dark past DARK_MIN, routes that missed their recipient, unreported exits and agents stuck on a prompt. */
export function livenessReport(input: LivenessInput): LivenessReport {
  const window = input.window ?? {};
  const keep = scopeTest(input.seats, window);
  const broker = input.broker.filter((e) => e.ts < input.asOf);
  const misses = routeMisses(broker);
  const dark = darkGaps(broker, misses, input.asOf).filter((g) => keep([g.seat], g.from));
  const routeMissesInScope = misses.filter((m) => keep([m.recipient], m.at));
  const routes = routeFailureRows(routeMissesInScope);
  const prompts = stalePromptRows(input.lastEvents, broker, input.asOf).filter((p) => !input.seats || input.seats.includes(p.agent));
  const exits = unreportedExitRows(broker.filter((e) => keep([stringField(e, "name") ?? "", stringField(e, "spawner") ?? ""], e.ts)), input.spawns);
  return {
    asOf: input.asOf,
    window,
    thresholds: { darkMin: DARK_MIN, promptStaleMin: PROMPT_STALE_MIN },
    sources: LIVENESS_SOURCES,
    darkSeats: { cites: ["registrations", "routes"], withTeleport: dark.filter((g) => g.teleport).length, withoutTeleport: dark.filter((g) => !g.teleport).length, rows: dark },
    routeFailures: { cites: ["routes"], ...countMisses(routeMissesInScope), rows: routes },
    unreportedExits: { cites: ["exits", "spawns"], total: sum(exits.map((r) => r.count)), rows: exits },
    stalePrompts: { cites: ["prompts", "registrations"], rows: prompts.filter((p) => p.resolutionEventId === null), resolvedRows: prompts.filter((p) => p.resolutionEventId !== null) },
  };
}

function scopeTest(seats: readonly string[] | undefined, window: { since?: string; until?: string }) {
  const named = seats ? new Set(seats) : null;
  return (names: readonly string[], at: string): boolean =>
    (!named || names.some((n) => named.has(n))) && (!window.since || at >= window.since) && (!window.until || at < window.until);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

const CITED_LINES = 4;

/** Up to CITED_LINES line numbers, then how many more the JSON carries. */
function cite(prefix: string, ids: readonly number[]): string {
  if (ids.length === 0) return "-";
  const shown = ids.slice(0, CITED_LINES).map((id) => `${prefix}${id}`).join(",");
  return ids.length > CITED_LINES ? `${shown} +${ids.length - CITED_LINES}` : shown;
}

/** Each table's title names the JSON field its rows come from; the sources and the shared caveat close the report. */
export function renderLivenessText(report: LivenessReport): string {
  const scope = `Liveness as of ${report.asOf}${report.window.since ? `, since ${report.window.since}` : ""}${report.window.until ? `, until ${report.window.until}` : ""}`;
  const sources = ["Sources", ...Object.entries(report.sources).map(([name, s]) => `${name}: ${s.command} (${s.field})`)].join("\n");
  return [scope, darkTable(report), routeTable(report), exitTable(report), promptTable(report), sources, LIST_PRICE_CAVEAT].join("\n\n") + "\n";
}

function darkTable(report: LivenessReport): string {
  const { rows, withTeleport, withoutTeleport } = report.darkSeats;
  const cells = rows.map((r) => [r.seat, r.from, r.to ?? "still dark", r.minutes, r.teleport ? "yes" : "no", r.failedRoutes, r.partialRoutes, r.queuedRoutes, cite("broker.log:", [...r.lines, ...r.routeLines])]);
  const title = `Seats dark over ${report.thresholds.darkMin} min, ${withTeleport} with a teleport and ${withoutTeleport} without [darkSeats.rows[]]`;
  return table(title, ["seat", "from", "to", "min", "teleport", "failed routes", "partial routes", "queued routes", "cites"], cells);
}

function routeTable(report: LivenessReport): string {
  const { rows, failed, partial, queued } = report.routeFailures;
  const cells = rows.map((r) => [r.recipient, r.failed, r.partial, r.queued, r.first, r.last, cite("broker.log:", r.lines)]);
  const title = `Routes that missed a recipient, ${failed} dropped, ${partial} partial and ${queued} held or queued for later [routeFailures.rows[]]`;
  return table(title, ["recipient", "failed", "partial", "queued", "first", "last", "cites"], cells);
}

function exitTable(report: LivenessReport): string {
  const cells = report.unreportedExits.rows.flatMap((r) => r.exits.map((e) => [r.profile, e.name, e.spawner, e.lastAction, e.at, cite("broker.log:", [e.line]), e.spawnEventId === null ? "-" : `events#${e.spawnEventId}`]));
  const title = `Unreported exits by profile, ${report.unreportedExits.total} in all [unreportedExits.rows[].exits[]]`;
  return table(title, ["profile", "agent", "spawner", "last action", "at", "exit", "spawn"], cells);
}

function promptTable(report: LivenessReport): string {
  const cells = (rows: LivenessReport["stalePrompts"]["rows"]) => rows.map((r) => [r.agent, r.tool ?? "-", r.at, r.ageMin, `events#${r.eventId}`, r.resolutionEventId === null ? "-" : `events#${r.resolutionEventId}`]);
  const head = ["agent", "tool", "at", "age min", "prompt", "resolution"];
  const over = `over ${report.thresholds.promptStaleMin} min old`;
  return [
    table(`Agents whose last event is an unresolved permission prompt ${over} [stalePrompts.rows[]]`, head, cells(report.stalePrompts.rows)),
    table(`Agents silent since a resolved permission prompt ${over} [stalePrompts.resolvedRows[]]`, head, cells(report.stalePrompts.resolvedRows)),
  ].join("\n\n");
}
