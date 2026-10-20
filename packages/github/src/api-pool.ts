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
  const { identity, send, clock } = options;
  const store = options.state ?? memoryPoolStateStore();
  const waiting: Waiter<C, A>[] = [];
  const lane = { busy: false, lastStart: Number.NEGATIVE_INFINITY };
  let seq = 0;
  let pumpQueued = false;
  let wakeAt: number | null = null;

  const pairOf = (callClass: CallClass) => store.get(identity, callClass) ?? OPEN;
  const closedUntil = (callClass: CallClass, now: number) => {
    const pair = pairOf(callClass);
    return pair.state === "closed" && pair.resetAt > now ? pair.resetAt : null;
  };

  function gate(waiter: Waiter<C, A>, now: number): Gate {
    const own = closedUntil(waiter.callClass, now);
    if (own !== null) return { grant: false, wakeAt: own };
    if (waiter.priority !== 1) {
      const others = CALL_CLASSES.map((callClass) => closedUntil(callClass, now)).filter((at): at is number => at !== null);
      if (others.length > 0) return { grant: false, wakeAt: Math.min(...others) };
    }
    if (waiter.callClass !== "mutation") return { grant: true };
    if (lane.busy) return { grant: false, wakeAt: null };
    const spacedAt = lane.lastStart + MUTATION_SPACING_MS;
    return spacedAt > now ? { grant: false, wakeAt: spacedAt } : { grant: true };
  }

  function pump(): void {
    pumpQueued = false;
    const now = clock.now();
    let nextWake: number | null = null;
    waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    for (const waiter of [...waiting]) {
      const decision = gate(waiter, now);
      if (decision.grant) {
        waiting.splice(waiting.indexOf(waiter), 1);
        start(waiter, now);
      } else if (decision.wakeAt !== null) {
        nextWake = Math.min(nextWake ?? decision.wakeAt, decision.wakeAt);
      }
    }
    if (nextWake !== null) armWake(nextWake, now);
  }

  function schedulePump(): void {
    if (pumpQueued) return;
    pumpQueued = true;
    queueMicrotask(pump);
  }

  function armWake(at: number, now: number): void {
    if (wakeAt !== null && wakeAt <= at) return;
    wakeAt = at;
    void clock.sleep(at - now).then(() => {
      if (wakeAt === at) wakeAt = null;
      schedulePump();
    });
  }

  function start(waiter: Waiter<C, A>, now: number): void {
    const holdsLane = waiter.callClass === "mutation";
    if (holdsLane) Object.assign(lane, { busy: true, lastStart: now });
    send(waiter.call)
      .then((answer) => settle(waiter.callClass, answer))
      .then(waiter.resolve, waiter.reject)
      .finally(() => {
        if (holdsLane) lane.busy = false;
        schedulePump();
      });
  }

  function settle(callClass: CallClass, answer: A): A | PoolUnavailable {
    const prior = pairOf(callClass);
    const now = clock.now();
    const failure = classify(callClass, answer, prior.streak, now);
    if (failure.kind === "ok") {
      if (prior.state !== "open" || prior.streak !== 0) store.set(identity, callClass, OPEN);
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
    store.set(identity, callClass, closed);
    return unavailableOf(callClass, closed);
  }

  return {
    run(priority, callClass, call) {
      return new Promise((resolve, reject) => {
        waiting.push({ priority, callClass, seq: seq++, call, resolve, reject });
        schedulePump();
      });
    },
  };
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
