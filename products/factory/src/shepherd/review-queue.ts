import { BUSY_LONGEST_WAIT_MS } from "./review-wait.js";

type Admission = { admit: true } | { admit: false; reason: string };

/** The PR a review is for, at the head its intent was recorded against. */
interface QueuedTarget {
  repo: string;
  pr: number;
  head?: string;
}

/** What a review spawn tells the gate: whether its PR is the fix for its repo's red main, and which PR it is, so status can name its place. */
export interface ReviewAsk {
  fixer: boolean;
  target?: QueuedTarget;
  /** When the run's sh-review-intent step recorded the review, from the store; it orders the queue across a serve restart, which forgets `firstAsk`. */
  intentAt?: number;
}

/** A review spawn the gate has refused and that is still asking. */
export interface WaitingReview extends ReviewAsk {
  name: string;
  firstAsk: number;
  lastAsk: number;
}

/** True when the run behind a queued ask has moved past it; `since` is when the ask's intent was recorded. */
export type MovedPast = (target: QueuedTarget, since: number) => boolean;

/** A refused review asks again after its busy wait, which grows to BUSY_LONGEST_WAIT_MS; one silent for two of those has stopped asking. */
export const REVIEW_STALE_MS = 2 * BUSY_LONGEST_WAIT_MS;

const waitingSince = (review: WaitingReview) => review.intentAt ?? review.firstAsk;

/** The open list some other poll already read; a reader that never reads GitHub, so the queue adds no polling of its own. */
export type CachedOpenList = (repo: string) => { prs: readonly { number: number; headSha: string }[]; at: number } | undefined;

/** A list read after the intent that shows the PR at another head, or no longer lists it as open, says the run has moved past its ask. */
export function movedPastOnList(cached: CachedOpenList): MovedPast {
  return (target, since) => {
    const list = target.head === undefined ? undefined : cached(target.repo);
    if (!list || list.at <= since) return false;
    return list.prs.find((pr) => pr.number === target.pr)?.headSha !== target.head;
  };
}

/** Pure: the reviews that asked within `staleMs`, fixers first, then by the time their intent was recorded. */
function reviewQueue(waiting: readonly WaitingReview[], now: number, staleMs: number): WaitingReview[] {
  return waiting.filter((review) => now - review.lastAsk <= staleMs).sort((a, b) => Number(b.fixer) - Number(a.fixer) || waitingSince(a) - waitingSince(b) || a.firstAsk - b.firstAsk);
}

/**
 * Pure: a review the machine would admit goes when it stands within the first `room` of the queue, the free review slots the load
 * check also allows; a red main's fix sorts first, then the oldest intent. Any other spawn is untouched.
 */
export function admitQueued(verdict: Admission, queue: readonly WaitingReview[], name: string, review: ReviewAsk | undefined, room: number): Admission {
  if (!verdict.admit || review === undefined) return verdict;
  const index = queue.findIndex((waiting) => waiting.name === name);
  const ahead = queue[0];
  if (!ahead || index < room) return verdict;
  return { admit: false, reason: ahead.fixer && !review.fixer ? `the review ${ahead.name} of a red main's fix waits ahead` : `the review ${ahead.name} with an older intent waits ahead, ${room} free review slots` };
}

/** The position and the oldest waiting intent, for the deferral log; empty for a spawn that is no review. */
export function queueNote(queue: readonly WaitingReview[], name: string): string {
  const oldest = queue[0];
  const index = queue.findIndex((waiting) => waiting.name === name);
  if (!oldest || index < 0) return "";
  return `; deferred: queue position ${index + 1} of ${queue.length} (oldest intent ${oldest.name} since ${new Date(waitingSince(oldest)).toISOString()})`;
}

/** Each waiting review's place by `repo#pr`; in memory, because only the live host's steps can be waiting. */
const positions = new Map<string, string>();
const positionKey = (repo: string, pr: number) => `${repo}#${pr}`;

/** "position 2 of 3" while the review of `repo#pr` waits on the gate; undefined otherwise. */
export function spawnQueuePosition(repo: string, pr: number | null): string | undefined {
  return pr === null ? undefined : positions.get(positionKey(repo, pr));
}

interface WaitListOptions {
  staleMs: number;
  movedPast?: MovedPast;
  log: (line: string) => void;
}

/** Drops each other ask whose run has moved past it; the asker itself has just asked, so it stays. */
function dropMoved(entries: Map<string, WaitingReview>, asker: string, { movedPast, log }: WaitListOptions): void {
  if (!movedPast) return;
  for (const review of [...entries.values()]) {
    if (review.name === asker || !review.target || !movedPast(review.target, waitingSince(review))) continue;
    entries.delete(review.name);
    log(`shepherd: spawn_gate dropped ${review.name}: its pull request moved past head ${review.target.head}`);
  }
}

/** The reviews one gate has refused, kept until each is admitted, stops asking or is moved past; every change republishes the positions it owns. */
export function reviewWaitList(options: WaitListOptions) {
  const entries = new Map<string, WaitingReview>();
  const published = new Set<string>();
  const publish = (at: number): WaitingReview[] => {
    const queue = reviewQueue([...entries.values()], at, options.staleMs);
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
      dropMoved(entries, name, options);
      return publish(at);
    },
    admitted(name: string, at: number): void {
      if (entries.delete(name)) publish(at);
    },
  };
}
