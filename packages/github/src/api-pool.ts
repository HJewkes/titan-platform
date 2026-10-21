import { probeVerdict, probedBucket, type RateLimitProbeAnswer } from "./api-pool-reopen.js";
import { classifyGitHubFailure, type CallClass, type GitHubFailure } from "./github-failure.js";

export type { RateLimitProbeAnswer } from "./api-pool-reopen.js";

export const POOL_PRIORITY = { outboxAndLander: 1, pacer: 2, itemReads: 3, backstop: 4 } as const;
export type PoolPriority = (typeof POOL_PRIORITY)[keyof typeof POOL_PRIORITY];

/** Each mutation starts at least this long after the previous one started (GitHub's secondary-limit guidance). */
export const MUTATION_SPACING_MS = 1000;

export interface PoolClock {
  /** Epoch milliseconds. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** What `send` resolves to; the pool reads only these fields and hands the whole answer back. */
export interface PoolAnswer {
  /** Absent for a network failure. */
  status?: number;
  /** Header names lower-cased. */
  headers: Readonly<Record<string, string | undefined>>;
  message?: string;
  networkError?: boolean;
}

export interface PoolPairState {
  /** `probed`: the probe found the tripped bucket open, and the next call of the class is the one canary. */
  state: "open" | "closed" | "probed";
  /** Epoch milliseconds; meaningful while closed or probed. */
  resetAt: number;
  streak: number;
  bucket?: string;
  reason?: string;
}

/** Mutable state per (identity, call class); a product swaps in a durable store so a restart keeps a pair closed. */
export interface PoolStateStore {
  get(identity: string, callClass: CallClass): PoolPairState | undefined;
  set(identity: string, callClass: CallClass, state: PoolPairState): void;
}

export interface PoolUnavailable {
  unavailable: { resetAt: number; reason: string; class: CallClass };
}

export interface GithubApiPoolOptions<C, A extends PoolAnswer> {
  identity: string;
  send: (call: C) => Promise<A>;
  clock: PoolClock;
  state?: PoolStateStore;
  /** `GET /rate_limit` as the identity; a closed pair's reopen starts with it once its `resetAt` passes. */
  probe: () => Promise<RateLimitProbeAnswer>;
  /** Once per reopen, when the canary returns ok; `resetAt` is the trip's. */
  onAvailable?: (identity: string, callClass: CallClass, resetAt: number) => void;
  /** Once per transition into auth state, never per call. */
  onAuthFailed?: (identity: string) => void;
}

export interface GithubApiPool<C, A extends PoolAnswer> {
  /** Resolves to the answer, or to `PoolUnavailable` when GitHub limited the call; an unavailable call never throws. */
  run(priority: PoolPriority, callClass: CallClass, call: C): Promise<A | PoolUnavailable>;
  /** The token reader saw a new token: leave auth state, and grant what it held. */
  tokenChanged(): void;
}

interface Waiter<C, A> {
  priority: PoolPriority;
  callClass: CallClass;
  seq: number;
  call: C;
  resolve: (value: A | PoolUnavailable) => void;
  reject: (error: unknown) => void;
}

/** A blocked waiter says when to look again; `null` means a release, not the clock, unblocks it. */
type Gate = { grant: true; canary: boolean } | { grant: false; wakeAt: number | null };

const HELD: Gate = { grant: false, wakeAt: null };

const CALL_CLASSES: readonly CallClass[] = ["core-read", "graphql", "mutation"];
const OPEN: PoolPairState = { state: "open", resetAt: 0, streak: 0 };

export function memoryPoolStateStore(): PoolStateStore {
  const rows = new Map<string, PoolPairState>();
  const key = (identity: string, callClass: CallClass) => `${identity}\u0000${callClass}`;
  return {
    get: (identity, callClass) => rows.get(key(identity, callClass)),
    set: (identity, callClass, state) => void rows.set(key(identity, callClass), { ...state }),
  };
}

export function isPoolUnavailable(value: unknown): value is PoolUnavailable {
  return typeof value === "object" && value !== null && "unavailable" in value;
}

export function githubApiPool<C, A extends PoolAnswer>(options: GithubApiPoolOptions<C, A>): GithubApiPool<C, A> {
  const core: PoolCore<C, A> = {
    ...options,
    store: options.state ?? memoryPoolStateStore(),
    waiting: [],
    lane: { busy: false, lastStart: Number.NEGATIVE_INFINITY },
    seq: 0,
    pumpQueued: false,
    wakeAt: null,
    reopen: { probing: new Set(), canary: new Set(), auth: false },
  };
  // A pair the store already holds closed is probed at its resetAt even if no call ever queues.
  schedulePump(core);
  return {
    run(priority, callClass, call) {
      return new Promise((resolve, reject) => {
        core.waiting.push({ priority, callClass, seq: core.seq++, call, resolve, reject });
        schedulePump(core);
      });
    },
    tokenChanged() {
      if (!core.reopen.auth) return;
      core.reopen.auth = false;
      schedulePump(core);
    },
  };
}

/** The part of a pool's state that reads and writes pairs; it does not depend on the call and answer types. */
interface PairView {
  identity: string;
  clock: PoolClock;
  store: PoolStateStore;
  lane: { busy: boolean; lastStart: number };
  /** In memory only, so a restart clears auth state, as a token change does. */
  reopen: { probing: Set<CallClass>; canary: Set<CallClass>; auth: boolean };
  onAvailable?: (identity: string, callClass: CallClass, resetAt: number) => void;
  onAuthFailed?: (identity: string) => void;
}

interface PoolCore<C, A extends PoolAnswer> extends PairView {
  send: (call: C) => Promise<A>;
  probe: () => Promise<RateLimitProbeAnswer>;
  waiting: Waiter<C, A>[];
  seq: number;
  pumpQueued: boolean;
  wakeAt: number | null;
}

function pairOf(core: PairView, callClass: CallClass): PoolPairState {
  return core.store.get(core.identity, callClass) ?? OPEN;
}

function closedUntil(core: PairView, callClass: CallClass, now: number): number | null {
  const pair = pairOf(core, callClass);
  return pair.state === "closed" && pair.resetAt > now ? pair.resetAt : null;
}

/** A closed pair past its resetAt waits on its probe, and a probed pair on its one canary; both are released, not timed. */
function ownGate(core: PairView, callClass: CallClass, now: number): Gate | null {
  const pair = pairOf(core, callClass);
  if (pair.state === "closed") return { grant: false, wakeAt: pair.resetAt > now ? pair.resetAt : null };
  return pair.state === "probed" && core.reopen.canary.has(callClass) ? HELD : null;
}

function gate(core: PairView, waiter: { priority: PoolPriority; callClass: CallClass }, now: number): Gate {
  if (core.reopen.auth) return HELD;
  const own = ownGate(core, waiter.callClass, now);
  if (own) return own;
  if (waiter.priority !== 1) {
    const others = CALL_CLASSES.map((callClass) => closedUntil(core, callClass, now)).filter((at): at is number => at !== null);
    if (others.length > 0) return { grant: false, wakeAt: Math.min(...others) };
  }
  const canary = pairOf(core, waiter.callClass).state === "probed";
  if (waiter.callClass !== "mutation") return { grant: true, canary };
  if (core.lane.busy) return HELD;
  const spacedAt = core.lane.lastStart + MUTATION_SPACING_MS;
  return spacedAt > now ? { grant: false, wakeAt: spacedAt } : { grant: true, canary };
}

function pump<C, A extends PoolAnswer>(core: PoolCore<C, A>): void {
  core.pumpQueued = false;
  const now = core.clock.now();
  let nextWake = startDueProbes(core, now);
  core.waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  for (const waiter of [...core.waiting]) {
    const decision = gate(core, waiter, now);
    if (decision.grant) {
      core.waiting.splice(core.waiting.indexOf(waiter), 1);
      start(core, waiter, now, decision.canary);
    } else if (decision.wakeAt !== null) {
      nextWake = Math.min(nextWake ?? decision.wakeAt, decision.wakeAt);
    }
  }
  if (nextWake !== null) armWake(core, nextWake, now);
}

/** Starts the probe of every closed pair whose resetAt has passed; returns the earliest resetAt still ahead. */
function startDueProbes<C, A extends PoolAnswer>(core: PoolCore<C, A>, now: number): number | null {
  if (core.reopen.auth) return null;
  let nextWake: number | null = null;
  for (const callClass of CALL_CLASSES) {
    const pair = pairOf(core, callClass);
    if (pair.state !== "closed") continue;
    if (pair.resetAt > now) nextWake = Math.min(nextWake ?? pair.resetAt, pair.resetAt);
    else if (!core.reopen.probing.has(callClass)) runProbe(core, callClass);
  }
  return nextWake;
}

function runProbe<C, A extends PoolAnswer>(core: PoolCore<C, A>, callClass: CallClass): void {
  core.reopen.probing.add(callClass);
  void core
    .probe()
    .catch(() => undefined)
    .then((answer) => {
      core.reopen.probing.delete(callClass);
      applyProbe(core, callClass, answer);
      schedulePump(core);
    });
}

function applyProbe(core: PairView, callClass: CallClass, answer: RateLimitProbeAnswer | undefined): void {
  const pair = pairOf(core, callClass);
  if (pair.state !== "closed") return;
  const verdict = probeVerdict(answer, probedBucket(callClass, pair.bucket), core.clock.now());
  if (verdict.kind === "auth") return enterAuth(core);
  const next: PoolPairState = verdict.kind === "pass" ? { ...pair, state: "probed" } : { ...pair, resetAt: verdict.resetAt, reason: verdict.reason };
  core.store.set(core.identity, callClass, next);
}

function enterAuth(core: PairView): void {
  if (core.reopen.auth) return;
  core.reopen.auth = true;
  core.onAuthFailed?.(core.identity);
}

function schedulePump<C, A extends PoolAnswer>(core: PoolCore<C, A>): void {
  if (core.pumpQueued) return;
  core.pumpQueued = true;
  queueMicrotask(() => pump(core));
}

function armWake<C, A extends PoolAnswer>(core: PoolCore<C, A>, at: number, now: number): void {
  if (core.wakeAt !== null && core.wakeAt <= at) return;
  core.wakeAt = at;
  void core.clock.sleep(at - now).then(() => {
    if (core.wakeAt === at) core.wakeAt = null;
    schedulePump(core);
  });
}

function start<C, A extends PoolAnswer>(core: PoolCore<C, A>, waiter: Waiter<C, A>, now: number, canary: boolean): void {
  const holdsLane = waiter.callClass === "mutation";
  if (holdsLane) Object.assign(core.lane, { busy: true, lastStart: now });
  if (canary) core.reopen.canary.add(waiter.callClass);
  core
    .send(waiter.call)
    .then((answer) => settle(core, waiter.callClass, answer, canary))
    .then(waiter.resolve, waiter.reject)
    .finally(() => {
      if (holdsLane) core.lane.busy = false;
      if (canary) core.reopen.canary.delete(waiter.callClass);
      schedulePump(core);
    });
}

/** Only the canary moves a pair that is not open: a call sent before the trip neither reopens it nor doubles its streak. */
function settle<A extends PoolAnswer>(core: PairView, callClass: CallClass, answer: A, canary: boolean): A | PoolUnavailable {
  const prior = pairOf(core, callClass);
  const now = core.clock.now();
  const failure = classify(callClass, answer, prior.streak, now);
  if (failure.kind === "auth") enterAuth(core);
  if (failure.kind === "ok" && canary) reopen(core, callClass, prior);
  if (failure.kind !== "unavailable") return answer;
  if (!canary && prior.state !== "open") return unavailableOf(callClass, prior);
  const closed: PoolPairState = {
    state: "closed",
    resetAt: failure.resetAt,
    streak: prior.streak + 1,
    bucket: failure.bucket,
    reason: failure.reason ?? `${failure.bucket} limited (${failure.source})`,
  };
  core.store.set(core.identity, callClass, closed);
  return unavailableOf(callClass, closed);
}

function reopen(core: PairView, callClass: CallClass, prior: PoolPairState): void {
  core.store.set(core.identity, callClass, OPEN);
  core.onAvailable?.(core.identity, callClass, prior.resetAt);
}

function unavailableOf(callClass: CallClass, pair: PoolPairState): PoolUnavailable {
  return { unavailable: { resetAt: pair.resetAt, reason: pair.reason ?? "", class: callClass } };
}

function classify(callClass: CallClass, answer: PoolAnswer, streak: number, now: number): GitHubFailure {
  return classifyGitHubFailure({
    status: answer.status,
    headers: answer.headers,
    message: answer.message ?? "",
    method: callClass === "core-read" ? "GET" : "POST",
    networkError: answer.networkError,
    graphql: callClass === "graphql",
    streak,
    now,
  });
}
