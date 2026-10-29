import { execFileSync } from "node:child_process";
import { availableParallelism, loadavg } from "node:os";
import { readLinuxMemory, type ReadFile } from "./machine-linux.js";
import { stopReason } from "./machine-stop.js";
import type { ReviewerReading, ReviewSlots } from "./review-slots.js";
import { reviewDispatcher, type ReviewStart } from "./review-dispatcher.js";
import { admitQueued, queueNote, reviewWaitList, type MovedPast, type ReviewAsk, type WaitingReview } from "./review-queue.js";
import { DEFAULT_HOLD_WAIT_MS } from "./review-wait.js";

/**
 * The machine limits a seat's own spawn passes (charter section 4, enforced by agent-chat in src/agents/seats/stops.ts and
 * src/agents/machine-guard.ts). They are copied here because the factory cannot call the broker's gate; unify them when agent-chat exposes it.
 */
export interface SpawnLimits {
  /** No new dispatch at a load5 above this. */
  load5: number;
  /** No new dispatch at a build-capable load5 above this; a review started in the last five minutes adds `reviewLoad` to the reading. */
  buildLoad5: number;
  /** The memory pressure level (1 normal, 2 warn, 4 critical) at which nothing starts. */
  pressureLevel: number;
  /** No new dispatch with less than this percent of memory free. */
  freeMemoryPct: number;
  /** Without headroom, the least interval between two factory spawns; 0 leaves load as the only limiter. */
  windowMs: number;
  /** The interval between admits while the machine has headroom (see `hasHeadroom`); 0 means none. */
  headroomIntervalMs: number;
  /** Headroom needs fewer unabsorbed reviews than this. */
  headroomReviews: number;
  /** The cores one unabsorbed review adds to the load readings it is compared with. */
  reviewLoad: number;
  /** No new dispatch while fewer cores than this stay idle: the cores less load1 less the unabsorbed reviews' `reviewLoad`. */
  minIdleCores: number;
  /** No review starts with fewer free bytes than this on the filesystem that holds review checkouts. */
  reviewMinFreeBytes: number;
  /** No review starts with fewer free inodes than this percent of that filesystem's, or than twice the last checkout's. */
  reviewMinFreeInodesPct: number;
  /** No review starts while this many reviewers run. */
  maxConcurrentReviews: number;
}

export const DEFAULT_SPAWN_LIMITS: SpawnLimits = {
  load5: 28,
  buildLoad5: 20,
  pressureLevel: 2,
  freeMemoryPct: 20,
  windowMs: 0,
  headroomIntervalMs: 0,
  headroomReviews: 4,
  // A 2026-10-29 sample of a 48-core host put every claude process together at ~0.3 core, each at 1-3% CPU, with reviewers running no tests; 0.05 covers one with margin.
  reviewLoad: 0.05,
  // A reviewer needs well under a core, so one idle core admits it; a host that also runs suites raises this (one vitest suite took ~7.5 cores in that sample).
  minIdleCores: 1,
  reviewMinFreeBytes: 5 * 1024 ** 3,
  reviewMinFreeInodesPct: 15,
  maxConcurrentReviews: 3,
};

/** A reading the machine would not give is absent, and the limit it feeds is not applied. */
export interface MachineReadings {
  load5: number;
  /** The one-minute load average, read as the cores busy now; with `cores` it gives the measured headroom. */
  load1?: number;
  /** The cores this process may use (`os.availableParallelism()`). */
  cores?: number;
  pressureLevel?: number;
  freeMemoryPct?: number;
}

/** The filesystem review checkouts are extracted onto; a reading it would not give is absent, and the floor it feeds is not applied. */
export interface CheckoutDisk {
  freeBytes?: number;
  freeInodes?: number;
  /** Zero on a filesystem that allocates inodes on demand, which has no inode floor. */
  totalInodes?: number;
  /** The inodes the newest measured checkout took. */
  lastCheckoutInodes?: number;
}

type Admission = { admit: true } | { admit: false; reason: string };

const refuse = (what: string, reading: number, limit: number): Admission => ({ admit: false, reason: `${what} ${reading} is past the limit ${limit}` });

/** load5 is a five-minute average, so a review older than this is already in the reading. */
const LOAD5_WINDOW_MS = 5 * 60_000;

/** darwin's memory pressure level for normal, which the Linux PSI reading maps onto. */
const PRESSURE_NORMAL = 1;

/** Load5 under half of buildLoad5, pressure read as normal and few unabsorbed reviews: the shorter interval is safe. */
function hasHeadroom(readings: MachineReadings, limits: SpawnLimits, unabsorbed: number): boolean {
  return readings.load5 < limits.buildLoad5 / 2 && readings.pressureLevel !== undefined && readings.pressureLevel <= PRESSURE_NORMAL && unabsorbed < limits.headroomReviews;
}

/** Pure: the interval since the last admit; with both intervals at 0 the load checks alone decide. */
function admitPace(limits: SpawnLimits, recentStarts: readonly number[], now: number, headroom: boolean): Admission {
  if (recentStarts.length === 0) return { admit: true };
  const sinceLast = now - Math.max(...recentStarts);
  const [interval, rule] = headroom ? [limits.headroomIntervalMs, "headroom interval"] : [limits.windowMs, "window"];
  return sinceLast < interval ? { admit: false, reason: `another spawn was admitted ${sinceLast} ms ago, inside the ${interval} ms ${rule}` } : { admit: true };
}

/**
 * The reviews load5 has not absorbed yet: those running under five minutes, and those admitted that no roster reading shows running.
 * `idle` is the cores left once they run, undefined when load1 or the core count is unread.
 */
function buildPressure(readings: MachineReadings, limits: SpawnLimits, runningReviews: readonly number[], now: number, admittedReviews: number) {
  const unabsorbed = runningReviews.filter((startedAt) => now - startedAt < LOAD5_WINDOW_MS).length + admittedReviews;
  const added = unabsorbed * limits.reviewLoad;
  const idle = readings.load1 === undefined || readings.cores === undefined ? undefined : readings.cores - readings.load1 - added;
  return { unabsorbed, build: readings.load5 + added, idle };
}

/**
 * Pure: the verdict for one spawn from the readings, the limits, the epoch-ms of earlier admissions, the start of each review already
 * running and the count of reviews admitted that are not running yet.
 */
export function admitSpawn(readings: MachineReadings, limits: SpawnLimits, recentStarts: readonly number[], now: number, runningReviews: readonly number[] = [], admittedReviews = 0): Admission {
  if (readings.load5 > limits.load5) return refuse("load5", readings.load5, limits.load5);
  const { unabsorbed, build, idle } = buildPressure(readings, limits, runningReviews, now, admittedReviews);
  if (build > limits.buildLoad5) return refuse(`load5 with ${unabsorbed} unabsorbed reviews`, build, limits.buildLoad5);
  if (idle !== undefined && idle < limits.minIdleCores) return { admit: false, reason: `idle cores ${Math.round(idle * 100) / 100} with ${unabsorbed} unabsorbed reviews are under the floor ${limits.minIdleCores}` };
  if (readings.pressureLevel !== undefined && readings.pressureLevel >= limits.pressureLevel) return refuse("memory pressure level", readings.pressureLevel, limits.pressureLevel);
  if (readings.freeMemoryPct !== undefined && readings.freeMemoryPct < limits.freeMemoryPct) return refuse("free memory percent", readings.freeMemoryPct, limits.freeMemoryPct);
  return admitPace(limits, recentStarts, now, hasHeadroom(readings, limits, unabsorbed));
}

/** The free inodes a checkout needs: a percent of the filesystem's, or twice the last checkout's, whichever is more; undefined when unread. */
function inodeFloor(disk: CheckoutDisk, limits: SpawnLimits): number | undefined {
  const share = disk.totalInodes ? Math.ceil((disk.totalInodes * limits.reviewMinFreeInodesPct) / 100) : undefined;
  const twice = disk.lastCheckoutInodes === undefined ? undefined : 2 * disk.lastCheckoutInodes;
  if (disk.totalInodes === 0 || (share === undefined && twice === undefined)) return undefined;
  return Math.max(share ?? 0, twice ?? 0);
}

/**
 * Pure: how many reviews may start now, so that many from the front of the queue can go at once: the free review slots, and the
 * count whose `reviewLoad` still fits under `buildLoad5` and over the idle-core floor. At least one, since it is read only once the gate would admit.
 */
function reviewRoom(readings: MachineReadings, limits: SpawnLimits, runningReviews: readonly number[], now: number, admittedReviews = 0): number {
  const { build, idle } = buildPressure(readings, limits, runningReviews, now, admittedReviews);
  const fits = (spare: number) => (limits.reviewLoad > 0 ? Math.floor(spare / limits.reviewLoad) + 1 : Infinity);
  const byLoad = Math.min(fits(limits.buildLoad5 - build), idle === undefined ? Infinity : fits(idle - limits.minIdleCores));
  // The concurrent cap is the backstop once the measured cost lets many reviews fit.
  const bySlots = limits.maxConcurrentReviews - runningReviews.length - admittedReviews;
  return Math.max(1, Math.min(byLoad, bySlots));
}

const occupied = (running: number, admitted: number) => `${running} reviews are running${admitted > 0 ? ` and ${admitted} more were admitted` : ""}`;

/** Pure: a review also needs a free reviewer slot and room for its checkout, which can run a filesystem out of inodes before bytes. */
function admitReview(disk: CheckoutDisk, limits: SpawnLimits, runningReviews: number, admittedReviews: number): Admission {
  const cap = limits.maxConcurrentReviews;
  if (runningReviews + admittedReviews >= cap) return { admit: false, reason: `${occupied(runningReviews, admittedReviews)}, the concurrent cap ${cap}` };
  if (disk.freeBytes !== undefined && disk.freeBytes < limits.reviewMinFreeBytes) return refuse("free bytes", disk.freeBytes, limits.reviewMinFreeBytes);
  const floor = inodeFloor(disk, limits);
  if (floor !== undefined && disk.freeInodes !== undefined && disk.freeInodes < floor) return refuse("free inodes", disk.freeInodes, floor);
  return { admit: true };
}

const SYSCTL = "/usr/sbin/sysctl";

function sysctlNumber(name: string): number | undefined {
  try {
    const value = Number.parseInt(execFileSync(SYSCTL, ["-n", name], { encoding: "utf8", timeout: 5000 }).trim(), 10);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

interface MachineSources {
  platform?: NodeJS.Platform;
  readFile?: ReadFile;
  sysctl?: (name: string) => number | undefined;
  loads?: () => readonly number[];
  cores?: () => number;
}

/** The same reads the broker's machine guard makes: `os.loadavg()`, then macOS sysctl or Linux /proc; absent elsewhere. Load1 and the core count give the headroom. */
export function readMachine({ platform = process.platform, readFile, sysctl = sysctlNumber, loads = loadavg, cores = availableParallelism }: MachineSources = {}): MachineReadings {
  const [load1, load5 = 0] = loads();
  const cpu = { load5, cores: cores(), ...(load1 !== undefined && { load1 }) };
  if (platform === "linux") return { ...cpu, ...readLinuxMemory(readFile) };
  return { ...cpu, pressureLevel: sysctl("kern.memorystatus_vm_pressure_level"), freeMemoryPct: sysctl("kern.memorystatus_level") };
}

/** Thrown when the gate would not admit a spawn; nobody was started, so the caller asks again on its next poll. */
export class SpawnDeferred extends Error {
  override readonly name = "SpawnDeferred";
}

export interface SpawnGate {
  /** Resolves when the spawn of `name` is admitted; throws `SpawnDeferred` when it is not. Only a review spawn passes `review`. */
  admit(name: string, runningReviews?: readonly number[], review?: ReviewAsk): void;
  /** Keeps the newest reading of the running reviewers, replacing the one before. */
  noteReviewers(reading: ReviewerReading): void;
  /** Undefined until a spawn has read the roster in this process. */
  reviewSlots(): ReviewSlots | undefined;
  /**
   * Queues a review and resolves once it has launched. It starts when it reaches the front on a trigger the gate admits on;
   * it rejects with `ReviewSuperseded` once its pull request moves past it, with `SpawnDeferred` once it outwaits the hold, and
   * with the reason of `signal` once that aborts.
   */
  queueReview(name: string, review: ReviewAsk, start: ReviewStart, signal?: AbortSignal): Promise<void>;
  /** A review ended, so a slot may be free: the queue's front asks again now rather than on the next tick. */
  reviewEnded(): void;
}

interface SpawnGateOptions {
  /** A function is read at every ask, so a reloaded config moves the limits without dropping the window or the queue. */
  limits?: Partial<SpawnLimits> | (() => Partial<SpawnLimits>);
  read?: () => MachineReadings;
  /** Read only for a review spawn; absent means unread, so no floor applies. */
  disk?: () => CheckoutDisk;
  now?: () => number;
  /** While a review waits, the queue's front asks again this often, so a machine that settles admits it. */
  tickMs?: number;
  /** A review queued this long gives up, as a machine hold that outlasts its ceiling does. */
  holdMs?: number;
  /** Tells when a queued review's run has moved past it, so it leaves the queue at once. */
  movedPast?: MovedPast;
  /** One line per admitted or deferred spawn; defaults to the factory log. */
  log?: (line: string) => void;
  /** Told of every machine-stop breach a spawn ask reads, whatever the verdict, so a review that ends later can see the stop held. */
  onStop?: (at: number, reason: string) => void;
}

const unread = (value: number | undefined) => value ?? "unread";

function diskNote(disk: CheckoutDisk, runningReviews: number): string {
  const last = disk.lastCheckoutInodes === undefined ? "unmeasured" : `${disk.lastCheckoutInodes} inodes`;
  return `; checkout fs ${unread(disk.freeBytes)} bytes, ${unread(disk.freeInodes)} of ${unread(disk.totalInodes)} inodes free, last checkout ${last}; ${runningReviews} reviews running`;
}

/** Reviews this gate admitted that no roster reading has shown running yet; each is unabsorbed from its admission until it shows or load5 takes it in. */
function admittedNotRunning() {
  const admitted = new Map<string, number>();
  return {
    add: (name: string, at: number) => void admitted.set(name, at),
    seen: (running: readonly string[]) => running.forEach((name) => admitted.delete(name)),
    count(at: number): number {
      for (const [name, admittedAt] of admitted) if (at - admittedAt >= LOAD5_WINDOW_MS) admitted.delete(name);
      return admitted.size;
    },
  };
}

/** The newest reviewer reading of this process, stamped with when it was read. */
function reviewSlotMemory(capOf: () => number, now: () => number, onRunning: (running: readonly string[]) => void): Pick<SpawnGate, "noteReviewers" | "reviewSlots"> {
  let slots: ReviewSlots | undefined;
  return {
    noteReviewers(reading) {
      const readAt = new Date(now()).toISOString();
      const cap = capOf();
      slots = "running" in reading ? { running: [...reading.running], cap, readAt } : { cap, readAt, rosterError: reading.rosterError };
      if ("running" in reading) onRunning(reading.running);
    },
    reviewSlots: () => slots && { ...slots },
  };
}

interface Ask {
  at: number;
  limits: SpawnLimits;
  readings: MachineReadings;
  runningReviews: readonly number[];
  admitted: number;
}

/** The machine verdict, then for a review its slot and checkout room, then its place in the queue within the room; a deferral on any keeps that place. */
function verdictFor(ask: Ask, starts: readonly number[], checkout: CheckoutDisk, queue: readonly WaitingReview[], name: string, review: ReviewAsk | undefined): Admission {
  const { at, limits, readings, runningReviews, admitted } = ask;
  const machine = admitSpawn(readings, limits, starts, at, runningReviews, admitted);
  if (!machine.admit || review === undefined) return machine;
  const room = reviewRoom(readings, limits, runningReviews, at, admitted);
  return admitQueued(admitReview(checkout, limits, runningReviews.length, admitted), queue, name, review, room);
}

/** A queued review asks again once a minute while it waits. */
const REVIEW_TICK_MS = 60_000;

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

function noteStop(ask: Ask, onStop: SpawnGateOptions["onStop"]): void {
  const stop = stopReason(ask.readings, ask.limits);
  if (stop !== undefined) onStop?.(ask.at, stop);
}

const coresNote = ({ load1, cores }: MachineReadings) => (load1 === undefined || cores === undefined ? "" : `, load1 ${load1} of ${cores} cores`);

const seenNote = (readings: MachineReadings, disk: string) => `load5 ${readings.load5}${coresNote(readings)}, pressure ${unread(readings.pressureLevel)}, free ${unread(readings.freeMemoryPct)}%${disk}`;

/** Logs and throws a deferral; an admission passes. */
function deferUnless(verdict: Admission, who: string, seen: string, log: (line: string) => void): void {
  if (verdict.admit) return;
  log(`shepherd: spawn_gate deferred ${who}${verdict.reason} ${seen}`);
  throw new SpawnDeferred(verdict.reason);
}

/** The one queue of reviews and the dispatcher that starts them from its front through `admit`. */
function queuedReviews(options: SpawnGateOptions, admit: SpawnGate["admit"], now: () => number, log: (line: string) => void) {
  const reviews = reviewWaitList({ movedPast: options.movedPast, log, onDrop: (name, head) => dispatcher.dropped(name, head) });
  const dispatcher = reviewDispatcher({
    enter: (name, review) => void reviews.ask(name, review, now()),
    order: () => reviews.order(),
    remove: (name) => reviews.remove(name),
    admit: (name, running, review) => admit(name, running, review),
    deferred: (error) => error instanceof SpawnDeferred,
    expired: (waitedMs) => new SpawnDeferred(`the review stayed queued for ${minutes(waitedMs)}`),
    now,
    tickMs: options.tickMs ?? REVIEW_TICK_MS,
    holdMs: options.holdMs ?? DEFAULT_HOLD_WAIT_MS,
  });
  return { reviews, dispatcher };
}

/** Remembers the admissions and the waiting reviews of this process, so every spawn site shares one pace and one queue. */
export function spawnGate(options: SpawnGateOptions = {}): SpawnGate {
  const limitsNow = (): SpawnLimits => ({ ...DEFAULT_SPAWN_LIMITS, ...(typeof options.limits === "function" ? options.limits() : options.limits) });
  const { read = () => readMachine(), disk = () => ({}), now = Date.now, log = (line) => console.warn(line) } = options;
  const starts: number[] = [];
  const pending = admittedNotRunning();
  const { reviews, dispatcher } = queuedReviews(options, (name, running, review) => gate.admit(name, running, review), now, log);
  const gate: Pick<SpawnGate, "admit"> = {
    admit(name, runningReviews = [], review) {
      const at = now();
      const ask: Ask = { at, limits: limitsNow(), readings: read(), runningReviews, admitted: pending.count(at) };
      noteStop(ask, options.onStop);
      const checkout = review ? disk() : {};
      const queue = review ? reviews.ask(name, review, ask.at) : [];
      const seen = seenNote(ask.readings, review ? diskNote(checkout, runningReviews.length) : "");
      deferUnless(verdictFor(ask, starts, checkout, queue, name, review), `${name}: `, `(${seen})${queueNote(queue, name)}`, log);
      starts.splice(0, starts.length, ask.at);
      if (review) pending.add(name, ask.at);
      reviews.remove(name);
      log(`shepherd: spawn_gate admitted ${name} (${seen})`);
    },
  };
  return {
    ...reviewSlotMemory(() => limitsNow().maxConcurrentReviews, now, pending.seen),
    ...gate,
    queueReview: (name, review, start, signal) => dispatcher.queue(name, review, start, signal),
    reviewEnded: () => void dispatcher.wake(),
  };
}
