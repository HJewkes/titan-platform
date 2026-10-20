import { classifyGitHubFailure, type CallClass, type GitHubFailure } from "./github-failure.js";

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
  state: "open" | "closed";
  /** Epoch milliseconds; meaningful while closed. */
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
}

export interface GithubApiPool<C, A extends PoolAnswer> {
  /** Resolves to the answer, or to `PoolUnavailable` when GitHub limited the call; an unavailable call never throws. */
  run(priority: PoolPriority, callClass: CallClass, call: C): Promise<A | PoolUnavailable>;
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
type Gate = { grant: true } | { grant: false; wakeAt: number | null };

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
  };
  return {
    run(priority, callClass, call) {
      return new Promise((resolve, reject) => {
        core.waiting.push({ priority, callClass, seq: core.seq++, call, resolve, reject });
        schedulePump(core);
      });
    },
  };
}

/** The part of a pool's state that reads and writes pairs; it does not depend on the call and answer types. */
interface PairView {
  identity: string;
  clock: PoolClock;
  store: PoolStateStore;
  lane: { busy: boolean; lastStart: number };
}

interface PoolCore<C, A extends PoolAnswer> extends PairView {
  send: (call: C) => Promise<A>;
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

function gate(core: PairView, waiter: { priority: PoolPriority; callClass: CallClass }, now: number): Gate {
  const own = closedUntil(core, waiter.callClass, now);
  if (own !== null) return { grant: false, wakeAt: own };
  if (waiter.priority !== 1) {
    const others = CALL_CLASSES.map((callClass) => closedUntil(core, callClass, now)).filter((at): at is number => at !== null);
    if (others.length > 0) return { grant: false, wakeAt: Math.min(...others) };
  }
  if (waiter.callClass !== "mutation") return { grant: true };
  if (core.lane.busy) return { grant: false, wakeAt: null };
  const spacedAt = core.lane.lastStart + MUTATION_SPACING_MS;
  return spacedAt > now ? { grant: false, wakeAt: spacedAt } : { grant: true };
}

function pump<C, A extends PoolAnswer>(core: PoolCore<C, A>): void {
  core.pumpQueued = false;
  const now = core.clock.now();
  let nextWake: number | null = null;
  core.waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  for (const waiter of [...core.waiting]) {
    const decision = gate(core, waiter, now);
    if (decision.grant) {
      core.waiting.splice(core.waiting.indexOf(waiter), 1);
      start(core, waiter, now);
    } else if (decision.wakeAt !== null) {
      nextWake = Math.min(nextWake ?? decision.wakeAt, decision.wakeAt);
    }
  }
  if (nextWake !== null) armWake(core, nextWake, now);
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

function start<C, A extends PoolAnswer>(core: PoolCore<C, A>, waiter: Waiter<C, A>, now: number): void {
  const holdsLane = waiter.callClass === "mutation";
  if (holdsLane) Object.assign(core.lane, { busy: true, lastStart: now });
  core
    .send(waiter.call)
    .then((answer) => settle(core, waiter.callClass, answer))
    .then(waiter.resolve, waiter.reject)
    .finally(() => {
      if (holdsLane) core.lane.busy = false;
      schedulePump(core);
    });
}

function settle<A extends PoolAnswer>(core: PairView, callClass: CallClass, answer: A): A | PoolUnavailable {
  const prior = pairOf(core, callClass);
  const now = core.clock.now();
  const failure = classify(callClass, answer, prior.streak, now);
  if (failure.kind === "ok") {
    if (prior.state !== "open" || prior.streak !== 0) core.store.set(core.identity, callClass, OPEN);
    return answer;
  }
  if (failure.kind !== "unavailable") return answer;
  // A call already in flight when its pair tripped hit the same limit; it must not double the streak again.
  if (prior.state === "closed" && prior.resetAt > now) return unavailableOf(callClass, prior);
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
