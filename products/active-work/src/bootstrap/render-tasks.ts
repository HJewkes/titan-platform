import { isDraft } from '../tasks/draft.js';
import type { Task } from '../schemas/task.js';
import { renderFacetTaskNote, selectFacetTasks } from './facet.js';

const RECENT_THRESHOLD_DAYS = 14;
const MS_PER_HOUR = 1000 * 60 * 60;
const MS_PER_DAY = MS_PER_HOUR * 24;
/**
 * Format the time between `from` and `now` as a human string.
 *
 * Thresholds:
 *  - < 1h          → "just now"
 *  - < 24h         → "X hours ago"
 *  - < 14d         → "X days ago"
 *  - >= 14d        → "X days ago — likely needs context refresher"
 */
export function formatTimeSince(from: Date, now: Date): string {
  const diffMs = now.getTime() - from.getTime();
  if (diffMs < MS_PER_HOUR) return 'just now';
  if (diffMs < MS_PER_DAY) {
    const hours = Math.floor(diffMs / MS_PER_HOUR);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(diffMs / MS_PER_DAY);
  const base = `${days} day${days === 1 ? '' : 's'} ago`;
  if (days >= RECENT_THRESHOLD_DAYS) {
    return `${base} — likely needs context refresher`;
  }
  return base;
}

export function compareTasksByPriority(a: Task, b: Task): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.id.localeCompare(b.id);
}

function nonBlankLines(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function firstLine(text: string | undefined): string | undefined {
  return nonBlankLines(text)[0];
}

const TASK_SUMMARY_MAX_LINES = 2;
const TASK_SUMMARY_MAX_CHARS = 200;

/**
 * Collapse `lines` into one bounded summary line, marking anything left behind.
 *
 * Same reasoning as `truncateLines`: a silently clipped excerpt reads as the
 * whole thought, so the cut is marked and paired with the command that prints
 * the field untruncated.
 */
function summarizeField(label: string, lines: string[], pointer: string): string {
  const kept = lines.slice(0, TASK_SUMMARY_MAX_LINES);
  const joined = kept.join(' ');
  const clamped =
    joined.length > TASK_SUMMARY_MAX_CHARS
      ? joined
          .slice(0, TASK_SUMMARY_MAX_CHARS)
          .replace(/\s+\S*$/, '')
          .trimEnd()
      : joined;
  // A mid-line cut still leaves content on that line, so it counts as remaining.
  const remaining = lines.length - kept.length + (clamped === joined ? 0 : 1);
  if (remaining === 0) return `${label}${clamped}`;
  const noun = remaining === 1 ? 'line' : 'lines';
  return `${label}${clamped}…(+${remaining} ${noun} — see ${pointer})`;
}

/**
 * The line under a task title answers "what does finishing this look like?".
 *
 * `done_when` answers it directly, so it wins. But roughly half the open tasks
 * in a real initiative have no `done_when`, and there a blank line reads as "no
 * context exists" when the notes are sitting right there on disk — so notes
 * become a bounded, marked fallback rather than nothing. Neither form is the
 * record of truth: both point at the command that prints the field in full.
 */
function renderTaskSummary(task: Task, slug: string): string | undefined {
  const pointer = `\`active-work task list ${slug} --json\``;
  const doneWhen = nonBlankLines(task.done_when);
  if (doneWhen.length > 0) {
    return summarizeField('done when: ', doneWhen, pointer);
  }
  const notes = nonBlankLines(task.notes);
  if (notes.length > 0) return summarizeField('notes: ', notes, pointer);
  return undefined;
}

function renderTaskLine(idx: number, task: Task, slug: string): string {
  const meta: string[] = [`priority ${task.priority}`];
  if (task.severity) meta.push(`severity ${task.severity}`);
  if (task.estimate !== undefined) meta.push(`est ${task.estimate}`);
  let line = `${idx}. [${task.id}] (${meta.join(', ')}) ${task.title}`;
  const summary = renderTaskSummary(task, slug);
  if (summary) line += `\n   ${summary}`;
  return line;
}

export function renderTopTasks(
  tasks: Task[],
  topN: number,
  slug: string,
  facetTags?: string[],
): { body: string; count: number } {
  const openTasks = tasks.filter((t) => t.status === 'open' && !isDraft(t)).sort(compareTasksByPriority);
  if (openTasks.length === 0) {
    return { body: '_No open tasks._', count: 0 };
  }
  const selection = selectFacetTasks(openTasks, facetTags);
  const lines = selection.tasks.slice(0, topN).map((task, i) => renderTaskLine(i + 1, task, slug));
  const facetNote = facetTags ? renderFacetTaskNote(selection, facetTags, slug) : null;
  if (facetNote) lines.push(facetNote);
  return { body: lines.join('\n'), count: openTasks.length };
}

/**
 * Recently-done tasks are backward-looking: they cost tokens in every bootstrap
 * but are rarely acted on. A count plus the exact lookup command keeps the
 * signal ("this much shipped here") at fixed size and lets the agent pull the
 * detail on the rare occasion it matters.
 */
export function renderRecentlyDone(
  tasks: Task[],
  windowDays: number,
  now: Date,
  slug: string,
): { body: string | null; count: number } {
  const done = recentlyDoneTasks(tasks, windowDays, now);
  if (done.length === 0) return { body: null, count: 0 };
  const noun = done.length === 1 ? 'task' : 'tasks';
  const body =
    `${done.length} ${noun} completed — ` +
    `\`active-work task list ${slug} --status done --json\``;
  return { body, count: done.length };
}

/**
 * Done tasks inside the window, newest first. `done_at` is DATE-only on older tasks (read as UTC
 * midnight) and a full timestamp on newer ones, so order by instant rather than by string.
 */
export function recentlyDoneTasks(tasks: Task[], windowDays: number, now: Date): Task[] {
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const doneAt = (t: Task): number => new Date(t.done_at ?? '').getTime();
  return tasks
    .filter((t) => t.status === 'done' && Number.isFinite(doneAt(t)) && doneAt(t) >= cutoff)
    .sort((a, b) => doneAt(b) - doneAt(a));
}
