import type { Nesting } from "./nesting.js";
import type { Token } from "./tokens.js";

const BUDGET_FLOOR = 4096;
const BUDGET_PER_CHAR = 16;

/**
 * Shared by every lexer state reading one source: each `((` position, and the `$` of each `$((`,
 * is tried once. The spend and the nesting are shared further, with heredoc bodies and backticks
 * lexed from that source, so all trials of one command read at most a few times its length and
 * crafted nesting can neither stall the guard nor overflow its stack.
 */
export interface ArithTrials {
  ends: Map<number, number>;
  /** The tokens of the arithmetic reading of the `$((` at each position, kept so a repeat visit reads nothing again. */
  arithmetic: Map<number, Token[][]>;
  /** The tokens of the `$( ( … ) )` reading of the `$((` at each position, lexed once so nested ones stay linear. */
  subshells: Map<number, Token[][]>;
  /** Set while a `$( ( … ) )` reading is lexed, whose nested `$((` add no reading of their own: the arithmetic reading of the outer span already holds them. */
  inSubshellReading: boolean;
  spend: { left: number };
  nesting: Nesting;
}

export function newTrials(src: string): ArithTrials {
  return { ends: new Map(), arithmetic: new Map(), subshells: new Map(), inSubshellReading: false, spend: { left: Math.max(BUDGET_FLOOR, BUDGET_PER_CHAR * src.length) }, nesting: { depth: 0 } };
}

/** Trials for text cut out of the source, such as a heredoc body: positions differ, the spend and nesting do not. */
export function sameSpend(trials: ArithTrials): ArithTrials {
  return { ends: new Map(), arithmetic: new Map(), subshells: new Map(), inSubshellReading: false, spend: trials.spend, nesting: trials.nesting };
}

/** The end `find` reports for the `((` at `at`, run at most once per position. */
export function cachedEnd(trials: ArithTrials, at: number, find: () => number): number {
  const known = trials.ends.get(at);
  if (known !== undefined) return known;
  const end = find();
  trials.ends.set(at, end);
  return end;
}

/** Charges `cost` characters read; false once the trials have spent their budget. */
export function chargeTrial(trials: ArithTrials, cost: number): boolean {
  trials.spend.left -= cost;
  return trials.spend.left >= 0;
}

export function spent(trials: ArithTrials): boolean {
  return trials.spend.left < 0;
}
