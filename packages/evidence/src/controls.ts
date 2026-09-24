import { randomInt, seededRandom } from "./seeded.js";

/** Picks n distinct entries from the pool, in an order fixed by the seed. n is capped at the pool size. */
export function pickControls<T>(pool: readonly T[], seed: string | number, n: number): T[] {
  const random = seededRandom(`pick:${seed}`);
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(random, i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j] as T, shuffled[i] as T];
  }
  return shuffled.slice(0, Math.max(0, n));
}

export type Planted<I, C> = { kind: "item"; value: I } | { kind: "control"; value: C };

export interface Placement<I, C> {
  sequence: Planted<I, C>[];
  /** Index of each control in the sequence, in control order. */
  positions: number[];
}

/** Inserts each control at a seeded position among the items, so controls do not cluster at the ends. */
export function placeControls<I, C>(items: readonly I[], controls: readonly C[], seed: string | number): Placement<I, C> {
  const random = seededRandom(`place:${seed}`);
  const sequence: Planted<I, C>[] = items.map((value) => ({ kind: "item", value }));
  const inserted: Planted<I, C>[] = [];
  for (const value of controls) {
    const entry: Planted<I, C> = { kind: "control", value };
    sequence.splice(randomInt(random, sequence.length + 1), 0, entry);
    inserted.push(entry);
  }
  return { sequence, positions: inserted.map((entry) => sequence.indexOf(entry)) };
}

export interface LabeledAnswer {
  id: string;
  label: string;
}

export interface LabelScore {
  expected: number;
  answered: number;
  correct: number;
  /** correct / answered; null when no control was answered with this label. */
  precision: number | null;
  /** correct / expected; null when no control expected this label. */
  recall: number | null;
}

export interface ControlScore {
  total: number;
  correct: number;
  /** Expected controls with no answer. They count against recall. */
  missing: number;
  accuracy: number | null;
  perLabel: Record<string, LabelScore>;
}

const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);

function tally(expected: readonly LabeledAnswer[], answers: ReadonlyMap<string, string>) {
  const counts = new Map<string, { expected: number; answered: number; correct: number }>();
  const bump = (label: string) => {
    let count = counts.get(label);
    if (!count) counts.set(label, (count = { expected: 0, answered: 0, correct: 0 }));
    return count;
  };
  for (const control of expected) {
    bump(control.label).expected++;
    const given = answers.get(control.id);
    if (given === undefined) continue;
    bump(given).answered++;
    if (given === control.label) bump(given).correct++;
  }
  return counts;
}

/** Scores answers against planted controls' expected labels. Answers for unknown ids are ignored. */
export function scoreControls(expected: readonly LabeledAnswer[], answered: readonly LabeledAnswer[]): ControlScore {
  const answers = new Map(answered.map((a) => [a.id, a.label]));
  const perLabel: Record<string, LabelScore> = {};
  let correct = 0;
  for (const [label, c] of tally(expected, answers)) {
    perLabel[label] = { ...c, precision: ratio(c.correct, c.answered), recall: ratio(c.correct, c.expected) };
    correct += c.correct;
  }
  const missing = expected.filter((control) => !answers.has(control.id)).length;
  return { total: expected.length, correct, missing, accuracy: ratio(correct, expected.length), perLabel };
}
