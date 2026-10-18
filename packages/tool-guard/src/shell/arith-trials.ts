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
  /** How many spans read two ways nest at each position that does. */
  depths: Map<number, number>;
  /**
   * `deepest` is the deepest such nesting met so far under the span being read, and `level`, while a `$( ( … ) )`
   * reading is lexed, how many such readings enclose the position being read. Both are shared with heredoc
   * bodies and backticks like the nesting, so a span nested through one still counts toward the limit.
   */
  bothReadings: { deepest: number; level: number };
  spend: { left: number };
  nesting: Nesting;
  /** Whether a `[[` at a bare command start joins its `&&` and `||`, which only a text read as bash, zsh or ksh may do. */
  joinsConditional: boolean;
}

function emptyTrials(): Pick<ArithTrials, "ends" | "arithmetic" | "subshells" | "depths"> {
  return { ends: new Map(), arithmetic: new Map(), subshells: new Map(), depths: new Map() };
}

export function newTrials(src: string, joinsConditional = false): ArithTrials {
  const spend = { left: Math.max(BUDGET_FLOOR, BUDGET_PER_CHAR * src.length) };
  return { ...emptyTrials(), bothReadings: { deepest: 0, level: 0 }, spend, nesting: { depth: 0 }, joinsConditional };
}

/** Trials for text cut out of the source, such as a heredoc body: positions differ, the spend and both depths do not. */
export function sameSpend(trials: ArithTrials): ArithTrials {
  const { bothReadings, spend, nesting, joinsConditional } = trials;
  return { ...emptyTrials(), bothReadings, spend, nesting, joinsConditional };
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
