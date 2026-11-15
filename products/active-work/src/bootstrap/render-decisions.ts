import type { LedgerRow } from '@titan-design/decider';

const MAX_LINES = 3;
const QUESTION_MAX = 90;
const ANSWER_MAX = 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max);
}

function askedMs(row: LedgerRow): number {
  return row.asked_at === null ? Number.NaN : Date.parse(row.asked_at);
}

function line(row: LedgerRow): string {
  const asked = (row.asked_at ?? '').slice(0, 10);
  const question = clip(row.header ?? row.question, QUESTION_MAX);
  return `- ${asked} Q: ${question} -> ${clip(row.answer ?? '', ANSWER_MAX)} (precedent ${row.key})`;
}

/** Answered rows this initiative claimed inside the window, newest first; null when there are none. */
export function renderRecentDecisions(
  rows: readonly LedgerRow[],
  slug: string,
  days: number,
  now: Date,
): string | null {
  const since = now.getTime() - days * MS_PER_DAY;
  const recent = rows
    .filter((row) => row.initiative === slug && row.answer !== null && askedMs(row) >= since)
    .sort((a, b) => askedMs(b) - askedMs(a));
  if (recent.length === 0) return null;
  return ['# Recent owner answers', ...recent.slice(0, MAX_LINES).map(line)].join('\n');
}
