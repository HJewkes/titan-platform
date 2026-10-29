import type { ReviewAsk, WaitingReview } from "./review-queue.js";

/** How a queued review starts once admitted: `running` reads the reviewers for the gate, then `launch` starts the agent. */
export interface ReviewStart {
  running: () => Promise<readonly number[]>;
  launch: () => Promise<void>;
}

/** The queued review's pull request moved to a new head or closed before its turn, so it never started. */
export class ReviewSuperseded extends Error {
  override readonly name = "ReviewSuperseded";

  /** `movedTo` is set when the live PR read, not the cached list, found the move; the step then answers as a resync would. */
  constructor(message: string, readonly moved?: { from: string; to: string }) {
    super(message);
  }
}

/** The open PR's head now; undefined when it cannot be read or is no longer open. */
export type LiveHead = (target: { repo: string; pr: number }) => Promise<string | undefined>;

/** What the dispatcher needs from the gate: the one queue, and the verdict that admits or defers the review at its front. */
interface DispatcherPorts {
  enter(name: string, review: ReviewAsk): void;
  order(): readonly WaitingReview[];
  remove(name: string): void;
  /** Throws `deferred` when the machine or the slots would not take the review now. */
  admit(name: string, running: readonly number[], review: ReviewAsk): void;
  deferred: (error: unknown) => boolean;
  /** Absent means no live read is made. */
  liveHead?: LiveHead;
  /** Thrown to a review still queued after `holdMs`, so its step can give up as it did on a long machine hold. */
  expired: (waitedMs: number) => Error;
  now: () => number;
  tickMs: number;
  holdMs: number;
}

interface Waiter extends ReviewStart {
  review: ReviewAsk;
  since: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** The queued starts by name, and a tick armed only while one waits. */
function waiterBook(ports: DispatcherPorts, onTick: () => void) {
  const waiting = new Map<string, Waiter>();
  let timer: ReturnType<typeof setInterval> | undefined;
  /** Takes `name` out of the queue, rejecting its waiter when `error` is given; returns the waiter it took. */
  const settle = (name: string, error?: unknown): Waiter | undefined => {
    const waiter = waiting.get(name);
    if (!waiter) return undefined;
    waiting.delete(name);
    ports.remove(name);
    if (waiting.size === 0) clearInterval(timer);
    if (waiting.size === 0) timer = undefined;
    if (error !== undefined) waiter.reject(error);
    return waiter;
  };
  const add = (name: string, waiter: Waiter) => {
    waiting.set(name, waiter);
    timer ??= setInterval(onTick, ports.tickMs);
    timer.unref();
  };
  return { waiting, settle, add };
}

type Book = ReturnType<typeof waiterBook>;

/** Gives up each waiter whose PR now stands at another head; one that cannot be read stays queued. */
async function dropMovedLive(ports: DispatcherPorts, book: Book): Promise<void> {
  const { liveHead } = ports;
  if (!liveHead) return;
  await Promise.all([...book.waiting].map(async ([name, { review }]) => {
    const { target } = review;
    if (!target?.head) return;
    const current = await liveHead(target).catch(() => undefined);
    if (current === undefined || current === target.head || !book.waiting.has(name)) return;
    book.settle(name, new ReviewSuperseded(`superseded: the pull request moved from head ${target.head} to ${current}`, { from: target.head, to: current }));
  }));
}

/** The queue's front that still has a waiter; undefined when none does. */
function frontOf(ports: DispatcherPorts, { waiting }: Book): (Waiter & { name: string }) | undefined {
  const name = ports.order().find((queued) => waiting.has(queued.name))?.name;
  const waiter = name === undefined ? undefined : waiting.get(name);
  return name === undefined || !waiter ? undefined : { ...waiter, name };
}

/** One pass over the front of the queue: gives up the expired, then admits and launches until the gate defers one. */
async function pass(ports: DispatcherPorts, book: Book): Promise<void> {
  const at = ports.now();
  await dropMovedLive(ports, book);
  for (const [name, waiter] of book.waiting) if (at - waiter.since >= ports.holdMs) book.settle(name, ports.expired(at - waiter.since));
  for (let front = frontOf(ports, book); front; front = frontOf(ports, book)) {
    try {
      const reviewers = await front.running();
      if (!book.waiting.has(front.name)) continue;
      ports.admit(front.name, reviewers, front.review);
    } catch (error) {
      if (ports.deferred(error)) return;
      book.settle(front.name, error);
      continue;
    }
    const started = book.settle(front.name);
    started?.launch().then(started.resolve, started.reject);
  }
}

/** Runs `work` one at a time; a call while it runs makes it run once more after, so no trigger is lost. */
function serial(work: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  let asked = 0;
  const loop = async () => {
    for (let served = -1; served !== asked; ) {
      served = asked;
      await work();
    }
  };
  return () => {
    asked += 1;
    running ??= loop().finally(() => (running = undefined));
    return running;
  };
}

/**
 * Starts queued reviews from the front of the one queue, as many as the gate admits, on three triggers only: an enqueue, a
 * review ending, and a tick while anything waits. A review never asks again on its own, so nothing polls per pull request.
 */
export function reviewDispatcher(ports: DispatcherPorts) {
  const book = waiterBook(ports, () => void pump());
  const pump = serial(() => pass(ports, book));
  return {
    /** The enqueue trigger: resolves once the review has launched, rejects when its launch fails, it is superseded or it outwaits `holdMs`. */
    queue(name: string, review: ReviewAsk, start: ReviewStart): Promise<void> {
      book.settle(name, new ReviewSuperseded(`${name} was queued again`));
      const started = new Promise<void>((resolve, reject) => book.add(name, { ...start, review, since: ports.now(), resolve, reject }));
      ports.enter(name, review);
      void pump();
      return started;
    },
    /** The review-ended trigger, and the tick's. */
    wake: (): Promise<void> => pump(),
    /** The queue dropped `name` because its pull request moved past `head`. */
    dropped(name: string, head: string | undefined): void {
      book.settle(name, new ReviewSuperseded(`its pull request moved past head ${head ?? "unknown"}`));
    },
  };
}
