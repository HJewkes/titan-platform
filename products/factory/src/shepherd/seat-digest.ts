import type { AgentRow } from "@titan-design/agent-dispatch";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches } from "../definition.js";
import type { FactoryHost } from "../host.js";
import { resolveCommand } from "../registry.js";
import { liveRoute, type ExitNoticePorts, type FallbackSeat } from "./exit-notice.js";
import { registrantSeat, runLineage, spawnerSeat } from "./registrant.js";
import { FINISHED_PHASES } from "./step-phase.js";
import type { ShepherdServices } from "./services.js";
import type { ShepherdStore } from "./store.js";
import type { WatchRow } from "./view.js";
import { holdsLiveSession } from "./wake-roster.js";
import { rowsWithRuns, runFinished } from "./watch-rows.js";
import { digestDelta, digestText, type DigestItem } from "./seat-digest-text.js";
import type { DigestPacer, DigestPacing, PendingItems } from "./seat-digest-pace.js";
import { digestWatches, watchedKeys, type DigestWatches } from "./watch-list.js";

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
  /** `shepherd.seatDigest.pacing`; absent sends each change on the sweep that sees it. */
  pacing?: DigestPacing;
}

/** The seat a run's digest lines go to. */
type SeatOf = (run: { repo: string; runId: string }) => string | undefined;

const repoSeats = (seatFor: (repo: string) => string | undefined): SeatOf => (run) => seatFor(run.repo);

/** A rerouted digest never reaches further back than this, however long its seat has gone untold. */
const REROUTE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * What a seat was last told: the open items by key with each one's PR ref, every finished run it has heard of, and when
 * it was last sent one. `refs` is optional so memory written before deltas still loads.
 */
const SeatStateSchema = z.object({ open: z.array(z.string()), refs: z.record(z.string(), z.string()).optional(), finished: z.array(z.string()), at: z.string().optional() });
export type SeatState = z.infer<typeof SeatStateSchema>;

export interface SeatDigestMemory {
  get(seat: string): SeatState | undefined;
  set(seat: string, state: SeatState): void;
}

export interface DigestInput {
  row: WatchRow;
  run: WorkflowRun;
}

interface SeatView {
  open: DigestItem[];
  finished: DigestItem[];
  /** Every finished run read, with or without an outcome to report, so the next sweep need not read it again. */
  settled: string[];
  /** The keys of open and finished items this seat's watch asked for: prompt-class, and a told end drops the watch. */
  watched: string[];
}

const SEAT_FIX_GATES: ReadonlySet<string> = new Set(["ci-failed", "sh-sent-back"]);
const SeatNoticeRecord = z.looseObject({ result: z.looseObject({ sent: z.literal(true), gate: z.string(), headSha: z.string() }) });

const pr = (row: WatchRow): string => `${row.repo}#${row.pr ?? row.branch}`;

function gateItem(row: WatchRow): DigestItem | undefined {
  const gate = row.pendingGate;
  if (gate === null) return undefined;
  const command = resolveCommand(row.runId, gate.stepId);
  return { key: `gate:${gate.gateId}`, line: `- ${pr(row)} waits on ${gate.stepId}: \`${command}\``, pr: pr(row), gate: { stepId: gate.stepId, command } };
}

function latestSeatNotice(run: WorkflowRun): StepResult | undefined {
  const notices = Object.values(run.stepResults).filter((result) => stepIdMatches("sh-seat-notice", result.stepId));
  return notices.sort((a, b) => a.completedAt.localeCompare(b.completedAt)).at(-1);
}

/** A run the seat was told to fix waits for a new head with no gate and no fixer; only its record shows the seat owns it. */
function seatFixItem({ row, run }: DigestInput): DigestItem | undefined {
  if (row.pendingGate !== null || row.outcome !== null || run.currentStep === null || !stepIdMatches("await-new-head", run.currentStep)) return undefined;
  const notice = SeatNoticeRecord.safeParse(latestSeatNotice(run)?.data);
  if (!notice.success || !SEAT_FIX_GATES.has(notice.data.result.gate) || notice.data.result.headSha !== row.headSha) return undefined;
  const { gate, headSha } = notice.data.result;
  return { key: `seat:${row.runId}:${gate}:${headSha}`, line: `- ${pr(row)} ${gate} at ${headSha.slice(0, 7)}, no fixer woken: start a fix round, push a fix, or close the PR`, pr: pr(row) };
}

function finishedItem(row: WatchRow): DigestItem | undefined {
  if (row.outcome === null) return undefined;
  const how = row.outcome.kind === "merged" ? "merged" : `stopped${row.outcome.reason === null ? "" : ` (${row.outcome.reason})`}`;
  return { key: row.runId, line: `- ${pr(row)} ${how}`, pr: pr(row) };
}

/**
 * Each seat's open items and finished runs, from the watch rows; a run no seat is named for is left out. A `quiet` run is
 * settled without a line, so the seat neither hears of it nor reads it again.
 */
function seatViews(inputs: readonly DigestInput[], routes: Pick<DigestRoutes, "seatOf" | "copyOf" | "watches">, quiet: (input: DigestInput) => boolean): Map<string, SeatView> {
  const views = new Map<string, SeatView>();
  for (const input of inputs) {
    const own = routes.seatOf(input.row);
    const copy = routes.copyOf?.(input.row);
    for (const seat of new Set([own, copy])) {
      if (seat === undefined) continue;
      const view = views.get(seat) ?? views.set(seat, { open: [], finished: [], settled: [], watched: [] }).get(seat)!;
      addRun(view, input, quiet, seat === (copy ?? own) ? routes.watches : undefined);
    }
  }
  return views;
}

/** `watches` is passed only for the seat watching the run: the copy seat when the watch names one, else the run's own. */
function addRun(view: SeatView, input: DigestInput, quiet: (input: DigestInput) => boolean, watches: DigestWatches | undefined): void {
  if (quiet(input)) {
    if (input.row.outcome !== null || FINISHED_PHASES.has(input.row.phase)) view.settled.push(input.row.runId);
    return;
  }
  const open = gateItem(input.row) ?? seatFixItem(input);
  if (open) view.open.push(open);
  const finished = finishedItem(input.row);
  if (finished) view.finished.push(finished);
  view.watched.push(...watchedKeys(watches?.of(input.row.runId), input.row, open?.key, finished?.key));
  if (FINISHED_PHASES.has(input.row.phase)) view.settled.push(input.row.runId);
}

/** A seat seen for the first time takes its finished runs as known, so a first sweep does not replay history; a watched end is still told. */
function freshRuns(view: SeatView, last: SeatState | undefined): DigestItem[] {
  const known = new Set(last?.finished ?? view.finished.filter((item) => !view.watched.includes(item.key)).map((item) => item.key));
  return view.finished.filter((item) => !known.has(item.key));
}

/** A new open item, a moved one included, and a watched run's end are prompt-class; a cleared item or another finished run is batch-class. */
function pendingItems(view: SeatView, fresh: readonly DigestItem[], last: SeatState | undefined): PendingItems {
  const delta = digestDelta(view.open, fresh, last);
  const watchedEnd = (item: DigestItem): boolean => view.watched.includes(item.key);
  const ended = (items: readonly DigestItem[]): string[] => items.map((item) => `finished:${item.key}`);
  return {
    prompt: [...delta.added.map((item) => item.key), ...ended(fresh.filter(watchedEnd))],
    batch: [...delta.cleared.map((key) => `cleared:${key}`), ...ended(fresh.filter((item) => !watchedEnd(item)))],
  };
}

/** Finished runs stay known once heard of, because a sweep reads only the finished runs its seat has not heard of. */
const stateOf = (view: SeatView, last: SeatState | undefined, sentAt: string | undefined): SeatState => ({
  open: view.open.map((item) => item.key).sort(),
  refs: Object.fromEntries([...view.open].sort((a, b) => a.key.localeCompare(b.key)).map((item) => [item.key, item.pr])),
  finished: [...new Set([...(last?.finished ?? []), ...view.finished.map((item) => item.key), ...view.settled])].sort(),
  at: sentAt ?? last?.at,
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

/** Where each run's digest goes, and why a seat neither live itself nor behind a live fallback is sent none. */
interface DigestRoutes {
  seatOf: SeatOf;
  unsendable: ReadonlyMap<string, string>;
  /** The run's own seat when its digest goes to a fallback because that seat holds no live session. */
  reroutedFrom?: SeatOf;
  /** The seats' watches: a watched event is prompt-class, and a watch is dropped once its run's end is told. */
  watches?: DigestWatches;
  /** The live seat a watch's `--seat` resolves to: it gets a copy of the run's lines, and the run's own seat keeps them. */
  copyOf?: SeatOf;
}

const finishedAt = ({ row, run }: DigestInput): string => run.completedAt ?? row.phaseSince;

/**
 * A rerouted run the fallback need not hear of (TP-4059): a finished one older than its own seat's last digest or the
 * window, so a dead seat's backlog is never replayed in one message. A run whose registrant's seat is live is never
 * rerouted, since `registrantSeat` and `spawnerSeat` name a seat only while live and `liveRoute` keeps a live seat.
 */
function rerouteQuiet(routes: Partial<DigestRoutes>, memory: SeatDigestMemory, now: Date): (input: DigestInput) => boolean {
  const floor = new Date(now.getTime() - REROUTE_WINDOW_MS).toISOString();
  return (input) => {
    const origin = routes.reroutedFrom?.(input.row);
    if (origin === undefined) return false;
    if (input.row.outcome === null && !FINISHED_PHASES.has(input.row.phase)) return false;
    const lastTold = memory.get(origin)?.at;
    const since = lastTold !== undefined && lastTold > floor ? lastTold : floor;
    return finishedAt(input) <= since;
  };
}

type DigestOutcome = { sent: string[]; failed: { seat: string; cause: string }[] };

/** Whether `pacer` holds a seat's change for a later sweep; a seat with nothing to say has nothing pending. */
function held(pacer: DigestPacer | undefined, seat: string, text: string | undefined, pending: () => PendingItems, now: Date): boolean {
  if (pacer === undefined) return false;
  if (text !== undefined) return !pacer.due(seat, pending(), now);
  pacer.clear(seat);
  return false;
}

/**
 * One message per seat whose state changed. A failed send leaves its memory alone, so the next sweep tries again, and so
 * does a seat `unsendable` names, whose reason is its failure's cause. A `pacer` the change is not yet due under holds it
 * the same way, so the send that comes due carries every unsent item.
 */
export async function sendSeatDigests(
  inputs: readonly DigestInput[], ports: SeatDigestPorts, memory: SeatDigestMemory, routes: Partial<DigestRoutes> = {}, now = new Date(), pacer?: DigestPacer,
): Promise<DigestOutcome> {
  const sent: string[] = [];
  const failed: { seat: string; cause: string }[] = [];
  const unsendable = routes.unsendable ?? new Map<string, string>();
  for (const [seat, view] of seatViews(inputs, { ...routes, seatOf: routes.seatOf ?? repoSeats(ports.seatLookup()) }, rerouteQuiet(routes, memory, now))) {
    const last = memory.get(seat);
    const fresh = freshRuns(view, last);
    const text = digestText(seat, view.open, fresh, last);
    if (held(pacer, seat, text, () => pendingItems(view, fresh, last), now)) continue;
    const why = text === undefined ? undefined : unsendable.get(seat);
    if (why !== undefined) {
      failed.push({ seat, cause: why });
      continue;
    }
    const state = stateOf(view, last, text === undefined ? undefined : now.toISOString());
    try {
      if (text !== undefined) await ports.send(seat, text);
      if (JSON.stringify(state) !== JSON.stringify(last)) memory.set(seat, state);
      if (text !== undefined) routes.watches?.drop(fresh.filter((item) => view.watched.includes(item.key)).map((item) => item.key));
      if (text !== undefined) sent.push(seat);
    } catch (error) {
      failed.push({ seat, cause: error instanceof Error ? error.message : String(error) });
    }
  }
  return { sent, failed };
}

/** An unread roster routes every digest by repo seat, as before registrants were recorded; the log says why. */
function unreadRoster(error: unknown): undefined {
  console.error(`shepherd: seat digests go by repo seat, the roster could not be read: ${error instanceof Error ? error.message : String(error)}`);
  return undefined;
}

/**
 * Each run's seat: the one its lineage names (`registrantSeat`), else the live seat that spawned its registrant
 * (`spawnerSeat`), else its repo's one seat, and none when the repo has no single seat (`runSeat`). The seat book is read
 * once, and the roster once, which also says which seats are live.
 */
async function runSeats(store: ShepherdStore, ports: SeatDigestPorts, watches: DigestWatches): Promise<DigestRoutes> {
  const seatFor = ports.seatLookup();
  const lineages = store.all().flatMap((registration) => (registration.registrant ? [{ runId: registration.runId, lineage: runLineage(store, registration) }] : []));
  const roster = ports.roster ? await ports.roster().catch(unreadRoster) : undefined;
  const named = new Map(lineages.map(({ runId, lineage }) => [runId, registrantSeat(lineage, roster) ?? spawnerSeat(lineage, roster)]));
  const chosen: SeatOf = (run) => {
    const seat = seatFor(run.repo);
    return seat && (named.get(run.runId) ?? seat);
  };
  const live = { ...(roster && { live: async (seat: string) => holdsLiveSession(seat, roster) }), ...(ports.fallbackSeats && { fallbackSeats: ports.fallbackSeats }) };
  const routes = await liveSeats(store.all(), chosen, live);
  const copies = await liveSeats(store.all(), (run) => watches.of(run.runId)?.seat ?? undefined, live);
  const watched = (run: { runId: string }): boolean => watches.of(run.runId) !== undefined;
  const reroutedFrom: SeatOf = (run) => (watched(run) ? undefined : routes.reroutedFrom?.(run));
  return { seatOf: routes.seatOf, unsendable: new Map([...routes.unsendable, ...copies.unsendable]), reroutedFrom, watches, copyOf: copies.seatOf };
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
  const reroutedFrom: SeatOf = (run) => {
    const seat = chosen(run);
    return seat !== undefined && seatOf(run) !== seat ? seat : undefined;
  };
  return { seatOf, unsendable, reroutedFrom };
}

/** One sweep over the host: each run's seat read once, and only the runs `digestReads` says the seats still need. */
export async function sweepSeatDigests(host: FactoryHost, services: ShepherdServices, ports: SeatDigestPorts, memory: SeatDigestMemory, now = new Date(), pacer?: DigestPacer): Promise<DigestOutcome> {
  const store = services.store.get();
  const watches = digestWatches(store);
  const routes = await runSeats(store, ports, watches);
  const reads = digestReads(memory, routes.seatOf);
  const watched = (runId: string): boolean => watches.of(runId) !== undefined;
  const inputs = await rowsWithRuns(host, services, (registration, status) => watched(registration.runId) || reads(registration, runFinished(status)));
  return sendSeatDigests(inputs, ports, memory, routes, now, pacer);
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
