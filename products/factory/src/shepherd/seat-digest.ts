import type { AgentRow } from "@titan-design/agent-dispatch";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches } from "../definition.js";
import type { FactoryHost } from "../host.js";
import { resolveCommand } from "../registry.js";
import { liveRoute, type ExitNoticePorts, type FallbackSeat } from "./exit-notice.js";
import { registrantSeat, runLineage } from "./registrant.js";
import { FINISHED_PHASES } from "./step-phase.js";
import type { ShepherdServices } from "./services.js";
import type { ShepherdStore } from "./store.js";
import type { WatchRow } from "./view.js";
import { holdsLiveSession } from "./wake-roster.js";
import { rowsWithRuns, runFinished } from "./watch-rows.js";

/** Often enough that a gate reaches its seat within a minute; the sweep reads only the local store, never GitHub. */
export const SEAT_DIGEST_MS = 60_000;
const SEAT_DIGEST_FILE = "seat-digest.json";

/**
 * Where a digest goes: the seat book read once per sweep, naming the one seat that owns a repo, the roster that names a
 * self-registered fixer's spawner and which seats are live, the fallbacks for a seat that is not, and the send. A run in
 * a repo no single seat owns gets no digest, whoever registered it.
 */
export interface SeatDigestPorts {
  seatLookup(): (repo: string) => string | undefined;
  roster?(): Promise<readonly AgentRow[]>;
  /** The seats a digest for `repo` goes to, in order, when its seat holds no live session, as for notices. */
  fallbackSeats?(repo: string): readonly FallbackSeat[];
  send(seat: string, text: string): Promise<void>;
}

/** The seat a run's digest lines go to. */
type SeatOf = (run: { repo: string; runId: string }) => string | undefined;

const repoSeats = (seatFor: (repo: string) => string | undefined): SeatOf => (run) => seatFor(run.repo);

/** What a seat was last told: the open items by key, and every finished run it has heard of. */
const SeatStateSchema = z.object({ open: z.array(z.string()), finished: z.array(z.string()) });
export type SeatState = z.infer<typeof SeatStateSchema>;

export interface SeatDigestMemory {
  get(seat: string): SeatState | undefined;
  set(seat: string, state: SeatState): void;
}

export interface DigestInput {
  row: WatchRow;
  run: WorkflowRun;
}

interface Item {
  key: string;
  line: string;
}

interface SeatView {
  open: Item[];
  finished: Item[];
  /** Every finished run read, with or without an outcome to report, so the next sweep need not read it again. */
  settled: string[];
}

const SEAT_FIX_GATES: ReadonlySet<string> = new Set(["ci-failed", "sh-sent-back"]);
const SeatNoticeRecord = z.looseObject({ result: z.looseObject({ sent: z.literal(true), gate: z.string(), headSha: z.string() }) });

const pr = (row: WatchRow): string => `${row.repo}#${row.pr ?? row.branch}`;

function gateItem(row: WatchRow): Item | undefined {
  const gate = row.pendingGate;
  if (gate === null) return undefined;
  return { key: `gate:${gate.gateId}`, line: `- ${pr(row)} waits on ${gate.stepId}: \`${resolveCommand(row.runId, gate.stepId)}\`` };
}

function latestSeatNotice(run: WorkflowRun): StepResult | undefined {
  const notices = Object.values(run.stepResults).filter((result) => stepIdMatches("sh-seat-notice", result.stepId));
  return notices.sort((a, b) => a.completedAt.localeCompare(b.completedAt)).at(-1);
}

/** A run the seat was told to fix waits for a new head with no gate and no fixer; only its record shows the seat owns it. */
function seatFixItem({ row, run }: DigestInput): Item | undefined {
  if (row.pendingGate !== null || row.outcome !== null || run.currentStep === null || !stepIdMatches("await-new-head", run.currentStep)) return undefined;
  const notice = SeatNoticeRecord.safeParse(latestSeatNotice(run)?.data);
  if (!notice.success || !SEAT_FIX_GATES.has(notice.data.result.gate) || notice.data.result.headSha !== row.headSha) return undefined;
  const { gate, headSha } = notice.data.result;
  return { key: `seat:${row.runId}:${gate}:${headSha}`, line: `- ${pr(row)} ${gate} at ${headSha.slice(0, 7)}, no fixer woken: start a fix round, push a fix, or close the PR` };
}

function finishedItem(row: WatchRow): Item | undefined {
  if (row.outcome === null) return undefined;
  const how = row.outcome.kind === "merged" ? "merged" : `stopped${row.outcome.reason === null ? "" : ` (${row.outcome.reason})`}`;
  return { key: row.runId, line: `- ${pr(row)} ${how}` };
}

/** Each seat's open items and finished runs, from the watch rows; a run no seat is named for is left out. */
function seatViews(inputs: readonly DigestInput[], seatOf: SeatOf): Map<string, SeatView> {
  const views = new Map<string, SeatView>();
  for (const input of inputs) {
    const seat = seatOf(input.row);
    if (seat === undefined) continue;
    const view = views.get(seat) ?? views.set(seat, { open: [], finished: [], settled: [] }).get(seat)!;
    const open = gateItem(input.row) ?? seatFixItem(input);
    if (open) view.open.push(open);
    const finished = finishedItem(input.row);
    if (finished) view.finished.push(finished);
    if (FINISHED_PHASES.has(input.row.phase)) view.settled.push(input.row.runId);
  }
  return views;
}

/**
 * The message for a change, or undefined when nothing changed. A seat seen for the first time has its finished runs
 * taken as already known, so a first sweep does not replay history; it hears only of open items.
 */
function digestText(seat: string, view: SeatView, last: SeatState | undefined): string | undefined {
  const known = new Set(last?.finished ?? view.finished.map((item) => item.key));
  const fresh = view.finished.filter((item) => !known.has(item.key));
  const open = [...view.open].sort((a, b) => a.key.localeCompare(b.key));
  const sameOpen = open.map((item) => item.key).join("\n") === [...(last?.open ?? [])].sort().join("\n");
  if (sameOpen && fresh.length === 0) return undefined;
  const lines = [`Shepherd digest for ${seat}: ${open.length} open, ${fresh.length} newly finished.`];
  lines.push(open.length > 0 ? "Open:" : "Open: none.", ...open.map((item) => item.line));
  if (fresh.length > 0) lines.push("Finished:", ...fresh.map((item) => item.line));
  return lines.join("\n");
}

/** Finished runs stay known once heard of, because a sweep reads only the finished runs its seat has not heard of. */
const stateOf = (view: SeatView, last: SeatState | undefined): SeatState => ({
  open: view.open.map((item) => item.key).sort(),
  finished: [...new Set([...(last?.finished ?? []), ...view.finished.map((item) => item.key), ...view.settled])].sort(),
});

/**
 * Whether a sweep must read a run: an unfinished one that has a seat, and a finished one only until that seat has heard
 * of it. A seat with no memory yet reads every run once, so its first sweep can take them all as known.
 */
export function digestReads(memory: SeatDigestMemory, seatOf: SeatOf): (run: { repo: string; runId: string }, finished: boolean) => boolean {
  const known = new Map<string, ReadonlySet<string> | undefined>();
  const knownBy = (seat: string): ReadonlySet<string> | undefined => {
    if (!known.has(seat)) {
      const last = memory.get(seat);
      known.set(seat, last && new Set(last.finished));
    }
    return known.get(seat);
  };
  return (run, finished) => {
    const seat = seatOf(run);
    if (seat === undefined) return false;
    return !finished || !(knownBy(seat)?.has(run.runId) ?? false);
  };
}

/**
 * One message per seat whose state changed. A failed send leaves its memory alone, so the next sweep tries again, and so
 * does a seat `unsendable` names, whose reason is its failure's cause.
 */
export async function sendSeatDigests(
  inputs: readonly DigestInput[],
  ports: SeatDigestPorts,
  memory: SeatDigestMemory,
  seatOf: SeatOf = repoSeats(ports.seatLookup()),
  unsendable: ReadonlyMap<string, string> = new Map(),
): Promise<{ sent: string[]; failed: { seat: string; cause: string }[] }> {
  const sent: string[] = [];
  const failed: { seat: string; cause: string }[] = [];
  for (const [seat, view] of seatViews(inputs, seatOf)) {
    const last = memory.get(seat);
    const text = digestText(seat, view, last);
    const why = text === undefined ? undefined : unsendable.get(seat);
    if (why !== undefined) {
      failed.push({ seat, cause: why });
      continue;
    }
    const state = stateOf(view, last);
    try {
      if (text !== undefined) await ports.send(seat, text);
      if (JSON.stringify(state) !== JSON.stringify(last)) memory.set(seat, state);
      if (text !== undefined) sent.push(seat);
    } catch (error) {
      failed.push({ seat, cause: error instanceof Error ? error.message : String(error) });
    }
  }
  return { sent, failed };
}

/** Where each run's digest goes, and why a seat neither live itself nor behind a live fallback is sent none. */
interface DigestRoutes {
  seatOf: SeatOf;
  unsendable: ReadonlyMap<string, string>;
}

/**
 * Each run's seat: the one its lineage names (`registrantSeat`), else its repo's one seat, and none when the repo has no
 * single seat (`runSeat`). The seat book is read once, and the roster once, which also says which seats are live.
 */
async function runSeats(store: ShepherdStore, ports: SeatDigestPorts): Promise<DigestRoutes> {
  const seatFor = ports.seatLookup();
  const lineages = store.all().flatMap((registration) => (registration.registrant ? [{ runId: registration.runId, lineage: runLineage(store, registration) }] : []));
  const roster = ports.roster ? await ports.roster().catch(() => undefined) : undefined;
  const named = new Map(lineages.map(({ runId, lineage }) => [runId, registrantSeat(lineage, roster)]));
  const chosen: SeatOf = (run) => {
    const seat = seatFor(run.repo);
    return seat && (named.get(run.runId) ?? seat);
  };
  const live = roster && { live: async (seat: string) => holdsLiveSession(seat, roster) };
  return liveSeats(store.all(), chosen, { ...live, ...(ports.fallbackSeats && { fallbackSeats: ports.fallbackSeats }) });
}

/**
 * The live-seat routing seat notices take (tp#2252): a chosen seat with no live session hands its runs to the first live
 * fallback, and with none live it keeps them and is recorded as unsendable. No readable roster keeps every seat.
 */
async function liveSeats(runs: readonly { repo: string; runId: string }[], chosen: SeatOf, ports: Pick<ExitNoticePorts, "live" | "fallbackSeats">): Promise<DigestRoutes> {
  const routed = new Map<string, string>();
  const unsendable = new Map<string, string>();
  const key = (repo: string, seat: string): string => `${repo}\n${seat}`;
  for (const run of runs) {
    const seat = chosen(run);
    if (seat === undefined || routed.has(key(run.repo, seat))) continue;
    const route = await liveRoute(ports, run.repo, seat);
    if ("none" in route) unsendable.set(seat, route.none);
    routed.set(key(run.repo, seat), "none" in route ? seat : route.seat);
  }
  const seatOf: SeatOf = (run) => {
    const seat = chosen(run);
    return seat && (routed.get(key(run.repo, seat)) ?? seat);
  };
  return { seatOf, unsendable };
}

/** One sweep over the host: each run's seat read once, and only the runs `digestReads` says the seats still need. */
export async function sweepSeatDigests(host: FactoryHost, services: ShepherdServices, ports: SeatDigestPorts, memory: SeatDigestMemory): ReturnType<typeof sendSeatDigests> {
  const { seatOf, unsendable } = await runSeats(services.store.get(), ports);
  const reads = digestReads(memory, seatOf);
  const inputs = await rowsWithRuns(host, services, (registration, status) => reads(registration, runFinished(status)));
  return sendSeatDigests(inputs, ports, memory, seatOf, unsendable);
}

const MemoryFile = z.record(z.string(), SeatStateSchema);

function readMemory(path: string): Record<string, SeatState> {
  if (!existsSync(path)) return {};
  try {
    const parsed = MemoryFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** The memory as one JSON file beside the factory database, so a restart does not resend; an unreadable file starts empty. */
export function fileSeatDigestMemory(stateDir: string): SeatDigestMemory {
  const path = join(stateDir, SEAT_DIGEST_FILE);
  const states = readMemory(path);
  return {
    get: (seat) => states[seat],
    set: (seat, state) => {
      states[seat] = state;
      writeFileSync(`${path}.tmp`, JSON.stringify(states));
      renameSync(`${path}.tmp`, path);
    },
  };
}
