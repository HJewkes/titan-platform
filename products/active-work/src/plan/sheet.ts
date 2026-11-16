import type { Bet, Outcome } from '@titan-design/pm';
import { stringify } from 'yaml';
import { shiftWeek, weekStart } from './iso-week.js';

/*
 * The weekly sheet (TP-5453 P16): one page per initiative the owner accepts, edits or ignores. Every item on it
 * states the default an ignored sheet records, and every bet line names the intent line and the metric it rests on.
 */

export const WEEKLY_SHEET_SCHEMA = 'titan-weekly-sheet/v1';

/** A prediction check as P17 (TP-6727) stores it on the bet as `prediction_check`. A bet with no check reads `unread`. */
export type PredictionCheck = 'confirmed' | 'missed' | 'unread';

/** The stored check, read through a guard until P17 adds `prediction_check` to the bet schema. */
function predictionCheckOf(bet: Bet): PredictionCheck {
  const stored: unknown = 'prediction_check' in bet ? bet.prediction_check : undefined;
  return stored === 'confirmed' || stored === 'missed' ? stored : 'unread';
}

/** One scorecard figure for the initiative: last week's value against this week's; null when not measured. */
export interface ScorecardReading {
  metric: string;
  previous: number | null;
  current: number | null;
}

export interface SheetInput {
  initiative: string;
  week: string;
  outcomes: readonly Outcome[];
  bets: readonly Bet[];
  scorecard: readonly ScorecardReading[];
}

export type SheetAction = 'select' | 'hold' | 'stop';

export interface SheetDefault {
  bet: string;
  action: SheetAction;
}

export interface SheetFlag {
  bet: string;
  problem: string;
}

export interface WeeklySheet {
  initiative: string;
  week: string;
  next_week: string;
  /** The last day the owner can answer; after it, `plan sheet apply-defaults` records the defaults. */
  deadline: string;
  defaults: SheetDefault[];
  flags: SheetFlag[];
  markdown: string;
}

const NO_INTENT = 'cites no intent line';

/** The intent line ids (`<initiative>/I<n>`) a bet cites; a decision id alone is not an intent line. */
function intentIds(bet: Bet): string[] {
  return (bet.cites ?? []).map((cite) => cite.intent_ref).filter((ref) => /^[a-z0-9-]+\/I\d+$/.test(ref));
}

function betLine(bet: Bet, tail: string): string {
  const intents = intentIds(bet);
  const intent = intents.length === 0 ? `FLAG ${NO_INTENT}` : intents.join(', ');
  const { metric, direction, baseline, expected, read_by: readBy } = bet.prediction;
  return `- ${bet.id} · intent: ${intent} · metric: ${metric} (${direction} ${baseline} → ${expected} by ${readBy}) · ${tail}`;
}

function readingLine(reading: ScorecardReading): string {
  return `- scorecard ${reading.metric}: ${reading.previous} → ${reading.current}`;
}

interface Sorted {
  confirmed: Bet[];
  missed: Bet[];
  unread: Bet[];
  proposed: Bet[];
}

function sortBets(input: SheetInput, nextWeek: string): Sorted {
  const byOrder = (a: Bet, b: Bet) => a.order - b.order;
  const running = input.bets.filter((bet) => bet.week === input.week && (bet.state === 'selected' || bet.state === 'done'));
  const withVerdict = (verdict: PredictionCheck) => running.filter((bet) => predictionCheckOf(bet) === verdict).sort(byOrder);
  return {
    confirmed: withVerdict('confirmed'),
    missed: withVerdict('missed'),
    unread: withVerdict('unread'),
    proposed: input.bets.filter((bet) => bet.week === nextWeek && bet.state === 'proposed').sort(byOrder),
  };
}

function sheetDefaults(sorted: Sorted): SheetDefault[] {
  const proposed = sorted.proposed.map((bet): SheetDefault => ({ bet: bet.id, action: intentIds(bet).length > 0 ? 'select' : 'hold' }));
  return [...proposed, ...sorted.missed.map((bet): SheetDefault => ({ bet: bet.id, action: 'stop' }))];
}

function sheetFlags(sorted: Sorted): SheetFlag[] {
  const bets = [...sorted.confirmed, ...sorted.missed, ...sorted.unread, ...sorted.proposed];
  return bets.filter((bet) => intentIds(bet).length === 0).map((bet) => ({ bet: bet.id, problem: NO_INTENT }));
}

function section(title: string, lines: readonly string[]): string[] {
  return [`## ${title}`, ...(lines.length === 0 ? ['- none'] : lines), ''];
}

function body(input: SheetInput, sorted: Sorted, defaults: readonly SheetDefault[]): string[] {
  const check = (bet: Bet) => betLine(bet, predictionCheckOf(bet));
  const measured = input.scorecard.filter((r) => r.previous !== null && r.current !== null);
  const action = (bet: Bet) => `default: ${defaults.find((d) => d.bet === bet.id)?.action}`;
  return [
    ...section('Statement', input.outcomes.filter((o) => o.state === 'active').map((o) => `- ${o.id}: ${o.statement} (measure: ${o.measure})`)),
    ...section('Moved', [...sorted.confirmed.map(check), ...measured.filter((r) => r.previous !== r.current).map(readingLine)]),
    ...section('Not moved', [...sorted.missed, ...sorted.unread].map(check).concat(measured.filter((r) => r.previous === r.current).map(readingLine))),
    ...section('Proposed bets', sorted.proposed.map((bet) => betLine(bet, action(bet)))),
    ...section('Proposed stops', sorted.missed.map((bet) => betLine(bet, `missed · ${action(bet)}`))),
  ];
}

/** Builds the sheet for one initiative's week; missed bets come before any new bet. */
export function buildWeeklySheet(input: SheetInput): WeeklySheet {
  const nextWeek = shiftWeek(input.week, 1);
  const sorted = sortBets(input, nextWeek);
  const defaults = sheetDefaults(sorted);
  const flags = sheetFlags(sorted);
  const deadline = weekStart(nextWeek);
  const front = { schema: WEEKLY_SHEET_SCHEMA, initiative: input.initiative, week: input.week, next_week: nextWeek, deadline, defaults, flags };
  const title = `# Weekly sheet: ${input.initiative}, ${input.week}`;
  const markdown = ['---', stringify(front).trimEnd(), '---', title, '', ...body(input, sorted, defaults)].join('\n');
  return { initiative: input.initiative, week: input.week, next_week: nextWeek, deadline, defaults, flags, markdown };
}
