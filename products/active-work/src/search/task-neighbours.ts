import type { Task } from '../schemas/task.js';
import { taskRef } from '../workspace-index/refs.js';
import { deriveQuery } from './derive-query.js';
import type { RelatedHit, RelatedInput, RelatedResult } from './related.js';
import { meaningfulTerms } from './terms.js';

/**
 * Task neighbours ranked from the tasks a caller already holds, with no index.
 *
 * The span FTS ranks every match across all classes before its scope applies, so
 * a tasks-only read over a full-size graph costs 0.7 s, on a thread a timer
 * cannot interrupt. Only one initiative's open tasks can ever be listed,
 * and those are already in memory.
 */

/** A shared title word says more about a duplicate than a shared done_when word. */
const TITLE_WEIGHT = 3;

/** Body length at which a word counts 1/sqrt(2): a long body shares words by chance. */
const BODY_NORM = 40;

interface TaskDoc {
  task: Task;
  title: Set<string>;
  body: Set<string>;
}

/**
 * Every term, not the rarest dozen: a term no task uses reads as the rarest of
 * all here, and would crowd out the words that can match.
 */
const ALL_TERMS = Number.POSITIVE_INFINITY;

type TermWeight = (term: string) => number;

type TaskScore = (terms: string[], doc: TaskDoc, weight: TermWeight) => number;

export interface TaskScanSeams {
  score?: TaskScore;
  now?: () => number;
}

interface TaskScanOptions extends TaskScanSeams {
  deadlineMs: number;
}

function toDoc(task: Task): TaskDoc {
  const title = meaningfulTerms(`${task.id} ${task.title}`);
  const body = meaningfulTerms(`${task.done_when ?? ''} ${task.notes ?? ''}`);
  return { task, title: new Set(title), body: new Set(body) };
}

const scoreTask: TaskScore = (terms, { title, body }, weight) =>
  terms.reduce((sum, term) => {
    if (title.has(term)) return sum + TITLE_WEIGHT * weight(term);
    return body.has(term) ? sum + weight(term) / Math.sqrt(1 + body.size / BODY_NORM) : sum;
  }, 0);

function documentFrequency(docs: TaskDoc[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { title, body } of docs) {
    for (const term of new Set([...title, ...body])) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

/** Checks the clock per item, so one synchronous pass cannot overrun by more than an item. */
function mapUntil<T, R>(
  items: T[],
  map: (item: T) => R,
  expired: () => boolean,
): R[] | undefined {
  const mapped: R[] = [];
  for (const item of items) {
    if (expired()) return undefined;
    mapped.push(map(item));
  }
  return mapped;
}

function toHit(task: Task, initiative: string | undefined): RelatedHit {
  return {
    ref: taskRef(task.id),
    class: 'tasks',
    initiative: initiative ?? null,
    title: task.title,
    path: null,
    excerpt: null,
    byteOffset: null,
    byteLength: null,
  };
}

function abandoned(result: Pick<RelatedResult, 'query'>, deadlineMs: number): RelatedResult {
  const message = `task scan passed ${deadlineMs} ms`;
  return { ...result, hits: [], degraded: [{ source: 'tasks', reason: 'timeout', message }] };
}

function topHits(scored: { task: Task; score: number }[], input: RelatedInput): RelatedHit[] {
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit)
    .map((entry) => toHit(entry.task, input.initiative));
}

export function scanTasks(
  input: RelatedInput,
  tasks: Task[],
  { deadlineMs, score = scoreTask, now = performance.now.bind(performance) }: TaskScanOptions,
): RelatedResult {
  const expiresAt = now() + deadlineMs;
  const expired = (): boolean => now() >= expiresAt;
  const exclude = new Set(input.exclude ?? []);
  const candidates = tasks.filter((task) => !exclude.has(taskRef(task.id)));

  const empty = { terms: [], expression: '' };
  const docs = mapUntil(candidates, toDoc, expired);
  if (docs === undefined) return abandoned({ query: empty }, deadlineMs);

  const df = documentFrequency(docs);
  const query = deriveQuery(input.text, (term) => df.get(term) ?? 0, { limit: ALL_TERMS });
  if (query.terms.length === 0) {
    const degraded = [{ source: 'query', reason: 'empty', message: 'no query terms' }];
    return { hits: [], degraded, query };
  }

  const weight: TermWeight = (term) => Math.log(1 + docs.length / (df.get(term) ?? 1));
  const scored = mapUntil(
    docs,
    (doc) => ({ task: doc.task, score: score(query.terms, doc, weight) }),
    expired,
  );
  if (scored === undefined) return abandoned({ query }, deadlineMs);

  return { hits: topHits(scored, input), degraded: [], query };
}
