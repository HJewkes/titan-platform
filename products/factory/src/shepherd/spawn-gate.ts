import { execFileSync } from "node:child_process";
import { loadavg } from "node:os";
import { readLinuxMemory, type ReadFile } from "./machine-linux.js";
import { BUSY_LONGEST_WAIT_MS } from "./review-wait.js";

/**
 * The machine limits a seat's own spawn passes (charter section 4, enforced by agent-chat in src/agents/seats/stops.ts and
 * src/agents/machine-guard.ts). They are copied here because the factory cannot call the broker's gate; unify them when agent-chat exposes it.
 */
interface SpawnLimits {
  /** No new dispatch at a load5 above this. */
  load5: number;
  /** No new dispatch at a build-capable load5 above this; a review started in the last five minutes adds `reviewLoad` to the reading. */
  buildLoad5: number;
  /** The memory pressure level (1 normal, 2 warn, 4 critical) at which nothing starts. */
  pressureLevel: number;
  /** No new dispatch with less than this percent of memory free. */
  freeMemoryPct: number;
  /** Without headroom, at most one factory spawn is admitted per window, so a burst of ready reviews does not start at once; with it, at most `burstMax` per window. */
  windowMs: number;
  /** The shorter interval between admits while the machine has headroom (see `hasHeadroom`). */
  headroomIntervalMs: number;
  /** The most admits inside any `windowMs`, whatever the interval. */
  burstMax: number;
  /** Headroom needs fewer unabsorbed reviews than this. */
  headroomReviews: number;
  /** What one running review adds to the load5 reading it is compared with. */
  reviewLoad: number;
}

export const DEFAULT_SPAWN_LIMITS: SpawnLimits = { load5: 28, buildLoad5: 20, pressureLevel: 2, freeMemoryPct: 20, windowMs: 60_000, headroomIntervalMs: 15_000, burstMax: 4, headroomReviews: 4, reviewLoad: 4 };

/** A reading the machine would not give is absent, and the limit it feeds is not applied. */
export interface MachineReadings {
  load5: number;
  pressureLevel?: number;
  freeMemoryPct?: number;
}

type Admission = { admit: true } | { admit: false; reason: string };

/** load5 is a five-minute average, so a review older than this is already in the reading. */
const LOAD5_WINDOW_MS = 5 * 60_000;

/** darwin's memory pressure level for normal, which the Linux PSI reading maps onto. */
const PRESSURE_NORMAL = 1;

/** Load5 under half of buildLoad5, pressure read as normal and few unabsorbed reviews: the shorter interval is safe. */
function hasHeadroom(readings: MachineReadings, limits: SpawnLimits, unabsorbed: number): boolean {
  return readings.load5 < limits.buildLoad5 / 2 && readings.pressureLevel !== undefined && readings.pressureLevel <= PRESSURE_NORMAL && unabsorbed < limits.headroomReviews;
}

/** Pure: the burst cap over the admits inside the window, then the interval since the last admit. */
function admitPace(limits: SpawnLimits, recentStarts: readonly number[], now: number, headroom: boolean): Admission {
  const inWindow = recentStarts.filter((startedAt) => now - startedAt < limits.windowMs).length;
  if (inWindow >= limits.burstMax) return { admit: false, reason: `${inWindow} spawns were admitted inside the last ${limits.windowMs} ms, the burst cap ${limits.burstMax}` };
  if (recentStarts.length === 0) return { admit: true };
  const sinceLast = now - Math.max(...recentStarts);
  const [interval, rule] = headroom ? [limits.headroomIntervalMs, "headroom interval"] : [limits.windowMs, "window"];
  return sinceLast < interval ? { admit: false, reason: `another spawn was admitted ${sinceLast} ms ago, inside the ${interval} ms ${rule}` } : { admit: true };
}

/** Pure: the verdict for one spawn from the readings, the limits, the epoch-ms of earlier admissions and the start of each review already running. */
export function admitSpawn(readings: MachineReadings, limits: SpawnLimits, recentStarts: readonly number[], now: number, runningReviews: readonly number[] = []): Admission {
  const refuse = (what: string, reading: number, limit: number): Admission => ({ admit: false, reason: `${what} ${reading} is past the limit ${limit}` });
  if (readings.load5 > limits.load5) return refuse("load5", readings.load5, limits.load5);
  const unabsorbed = runningReviews.filter((startedAt) => now - startedAt < LOAD5_WINDOW_MS).length;
  const build = readings.load5 + unabsorbed * limits.reviewLoad;
  if (build > limits.buildLoad5) return refuse(`load5 with ${unabsorbed} unabsorbed reviews`, build, limits.buildLoad5);
  if (readings.pressureLevel !== undefined && readings.pressureLevel >= limits.pressureLevel) return refuse("memory pressure level", readings.pressureLevel, limits.pressureLevel);
  if (readings.freeMemoryPct !== undefined && readings.freeMemoryPct < limits.freeMemoryPct) return refuse("free memory percent", readings.freeMemoryPct, limits.freeMemoryPct);
  return admitPace(limits, recentStarts, now, hasHeadroom(readings, limits, unabsorbed));
}

/** What a review spawn tells the gate: whether its PR is the fix for its repo's red main, and which PR it is, so status can name its place. */
export interface ReviewAsk {
  fixer: boolean;
  target?: { repo: string; pr: number };
}

/** A review spawn the gate has refused and that is still asking. */
interface WaitingReview extends ReviewAsk {
  name: string;
  firstAsk: number;
  lastAsk: number;
}

/** A refused review asks again after its busy wait, which grows to BUSY_LONGEST_WAIT_MS; one silent for two of those has stopped asking. */
export const REVIEW_STALE_MS = 2 * BUSY_LONGEST_WAIT_MS;

/** Pure: the reviews that asked within `staleMs`, fixers first, then by first ask. */
function reviewQueue(waiting: readonly WaitingReview[], now: number, staleMs: number): WaitingReview[] {
  return waiting.filter((review) => now - review.lastAsk <= staleMs).sort((a, b) => Number(b.fixer) - Number(a.fixer) || a.firstAsk - b.firstAsk);
}

/** Pure: a review that is no fixer waits while a fixer's review is queued, so a red main's fix takes the next slot; any other spawn is untouched. */
function admitQueued(verdict: Admission, queue: readonly WaitingReview[], name: string, review: ReviewAsk | undefined): Admission {
  if (!verdict.admit || review === undefined || review.fixer) return verdict;
  const fixer = queue.find((waiting) => waiting.fixer && waiting.name !== name);
  return fixer ? { admit: false, reason: `the review ${fixer.name} of a red main's fix waits ahead` } : verdict;
}

/** Each waiting review's place by `repo#pr`; in memory, because only the live host's steps can be waiting. */
const positions = new Map<string, string>();
const positionKey = (repo: string, pr: number) => `${repo}#${pr}`;

/** "position 2 of 3" while the review of `repo#pr` waits on the gate; undefined otherwise. */
export function spawnQueuePosition(repo: string, pr: number | null): string | undefined {
  return pr === null ? undefined : positions.get(positionKey(repo, pr));
}

/** The reviews one gate has refused, kept until each is admitted or stops asking; every change republishes the positions it owns. */
function reviewWaitList(staleMs: number) {
  const entries = new Map<string, WaitingReview>();
  const published = new Set<string>();
  const publish = (at: number): WaitingReview[] => {
    const queue = reviewQueue([...entries.values()], at, staleMs);
    entries.clear();
    queue.forEach((review) => entries.set(review.name, review));
    published.forEach((key) => positions.delete(key));
    published.clear();
    queue.forEach(({ target }, index) => {
      if (!target) return;
      const key = positionKey(target.repo, target.pr);
      published.add(key);
      positions.set(key, `position ${index + 1} of ${queue.length}`);
    });
    return queue;
  };
  return {
    ask(name: string, review: ReviewAsk, at: number): WaitingReview[] {
      entries.set(name, { ...review, name, firstAsk: entries.get(name)?.firstAsk ?? at, lastAsk: at });
      return publish(at);
    },
    admitted(name: string, at: number): void {
      if (entries.delete(name)) publish(at);
    },
  };
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
}

/** The same reads the broker's machine guard makes: `os.loadavg()[1]`, then macOS sysctl or Linux /proc; absent elsewhere. */
export function readMachine({ platform = process.platform, readFile, sysctl = sysctlNumber }: MachineSources = {}): MachineReadings {
  const load5 = loadavg()[1] ?? 0;
  if (platform === "linux") return { load5, ...readLinuxMemory(readFile) };
  return { load5, pressureLevel: sysctl("kern.memorystatus_vm_pressure_level"), freeMemoryPct: sysctl("kern.memorystatus_level") };
}

/** Thrown when the gate would not admit a spawn; nobody was started, so the caller asks again on its next poll. */
export class SpawnDeferred extends Error {
  override readonly name = "SpawnDeferred";
}

export interface SpawnGate {
  /** Resolves when the spawn of `name` is admitted; throws `SpawnDeferred` when it is not. Only a review spawn passes `review`. */
  admit(name: string, runningReviews?: readonly number[], review?: ReviewAsk): void;
}

interface SpawnGateOptions {
  limits?: Partial<SpawnLimits>;
  read?: () => MachineReadings;
  now?: () => number;
  /** How long a refused review stays queued without asking again. */
  reviewStaleMs?: number;
  /** One line per admitted or deferred spawn; defaults to the factory log. */
  log?: (line: string) => void;
}

/** Remembers the admissions and the waiting reviews of this process, so every spawn site shares one window and one queue. */
export function spawnGate(options: SpawnGateOptions = {}): SpawnGate {
  const limits = { ...DEFAULT_SPAWN_LIMITS, ...options.limits };
  const { read = () => readMachine(), now = Date.now, log = (line) => console.warn(line) } = options;
  const starts: number[] = [];
  const reviews = reviewWaitList(options.reviewStaleMs ?? REVIEW_STALE_MS);
  return {
    admit(name, runningReviews = [], review) {
      const at = now();
      const readings = read();
      const queue = review ? reviews.ask(name, review, at) : [];
      const verdict = admitQueued(admitSpawn(readings, limits, starts, at, runningReviews), queue, name, review);
      const seen = `load5 ${readings.load5}, pressure ${readings.pressureLevel ?? "unread"}, free ${readings.freeMemoryPct ?? "unread"}%`;
      if (!verdict.admit) {
        log(`shepherd: spawn_gate deferred ${name}: ${verdict.reason} (${seen})`);
        throw new SpawnDeferred(verdict.reason);
      }
      starts.splice(0, starts.length, ...starts.filter((startedAt) => at - startedAt < limits.windowMs), at);
      reviews.admitted(name, at);
      log(`shepherd: spawn_gate admitted ${name} (${seen})`);
    },
  };
}
