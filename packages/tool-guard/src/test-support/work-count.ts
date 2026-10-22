import { expect } from "vitest";

const indexOf = String.prototype.indexOf;
const len = (value: unknown): number => String(value).length;
const at = (value: unknown, fallback: number): number => (value === undefined ? fallback : Math.max(0, Math.trunc(Number(value)) || 0));

/** The characters a search from `from` read before it found `found` at `index`, or to the end when it found none. */
const searched = (text: string, from: number, index: number, found: number): number => (index < 0 ? text.length - from : index - from + found);

/** The weight of one call, from its receiver, arguments and result; `from` is where a global or sticky regex starts. */
type Weigh = (self: unknown, args: unknown[], result: unknown, from: number) => number;

/** The characters a regex call read: up to the end of its match, or to the end of the input when it found none. */
const execWeight: Weigh = (_self, [input], result, from) => {
  const match = result as RegExpExecArray | null;
  return match === null ? len(input) - from : match.index + match[0].length - from;
};

const startOf = (self: unknown): number => (self instanceof RegExp && (self.global || self.sticky) ? self.lastIndex : 0);

/**
 * The string and pattern primitives the lexer and classifier read their input through, each weighed by the characters
 * it reads, as its result shows; and `push`, which a scan that indexes characters directly still calls for what it
 * collects. A rescan through `indexOf` or a regex weighs as much as one a character at a time, so a walk that repeats
 * per character, bracket or reading costs more with it. The weight is the same on every machine and under any load
 * (TP-4047). A regex's backtracking is not seen; time those with `expectLinearTime`.
 */
const WEIGHED: Array<[object, string, Weigh]> = [
  [String.prototype, "indexOf", (self, [search, from], index) => searched(String(self), at(from, 0), index as number, len(search))],
  [String.prototype, "lastIndexOf", (self, _args, index) => len(self) - Math.max(0, index as number)],
  [String.prototype, "includes", (self, [search, from]) => searched(String(self), at(from, 0), Reflect.apply(indexOf, self, [search, from]) as number, len(search))],
  [String.prototype, "startsWith", (_self, [search]) => len(search)],
  [String.prototype, "endsWith", (_self, [search]) => len(search)],
  // V8 slices a long string by reference, without copying it; reading the slice later is what costs.
  [String.prototype, "slice", () => 1],
  [String.prototype, "charAt", () => 1],
  [String.prototype, "charCodeAt", () => 1],
  [String.prototype, "codePointAt", () => 1],
  // `test` reads through `exec`, which weighs it.
  [RegExp.prototype, "test", () => 1],
  [RegExp.prototype, "exec", execWeight],
  [Array.prototype, "push", (_self, args) => args.length],
];

class WorkCapExceeded extends Error {}

function wrap(original: (...args: unknown[]) => unknown, weigh: Weigh, onWork: (weight: number) => void) {
  return function (this: unknown, ...args: unknown[]): unknown {
    const from = startOf(this);
    const result = Reflect.apply(original, this, args);
    onWork(Math.max(1, weigh(this, args, result, from)));
    return result;
  };
}

function patch(onWork: (weight: number) => void): () => void {
  const originals = WEIGHED.map(([proto, key]) => Object.getOwnPropertyDescriptor(proto, key));
  WEIGHED.forEach(([proto, key, weigh], i) => {
    const original: unknown = originals[i]?.value;
    if (typeof original !== "function") throw new Error(`no ${key} to count`);
    Object.defineProperty(proto, key, { configurable: true, writable: true, value: wrap(original as (...args: unknown[]) => unknown, weigh, onWork) });
  });
  return () => WEIGHED.forEach(([proto, key], i) => Object.defineProperty(proto, key, originals[i] ?? {}));
}

/**
 * The work `read` does: the characters its counted calls read. The call that passes `cap` throws and puts the
 * primitives back, so a runaway walk stops there, and code that runs on after catching it, as the hook catches all,
 * runs uncounted. The count then fails an assertion either way. The classifier caches per source, so a source an
 * earlier test already read counts less: give each count a fresh one.
 */
export async function countWork(read: () => unknown, cap = Infinity): Promise<number> {
  let work = 0;
  let restored = false;
  const restoreOnce = () => {
    if (!restored) restore();
    restored = true;
  };
  const restore = patch((weight) => {
    work += weight;
    if (work <= cap || restored) return;
    restoreOnce();
    throw new WorkCapExceeded(`more than ${cap} characters of work`);
  });
  let thrown: unknown = null;
  try {
    // A synchronous read is counted to its end before this yields, so the caller's own code never runs counted. An
    // async one counts whatever runs while it waits; await the count at once.
    const pending = read();
    if (pending instanceof Promise) await pending;
  } catch (error) {
    thrown = error;
  } finally {
    restoreOnce();
  }
  expect(work, "characters of work").toBeLessThanOrEqual(cap);
  if (thrown !== null) throw thrown;
  return work;
}

/** Asserts `read` reads at most `perChar` characters per character of an input `chars` long, and returns its work. */
export function expectWorkPerChar(read: () => unknown, chars: number, perChar: number): Promise<number> {
  return countWork(read, Math.ceil(chars * perChar));
}

const GROWTH = 8;
/** A linear walk does GROWTH times the work on a GROWTH times larger input, a quadratic one GROWTH squared. */
const MAX_GROWTH = GROWTH * 1.5;

/**
 * Asserts the work grows no faster than linearly: `prepare(size)` builds the input outside the count and returns the
 * counted operation. A run at `topSize` may do at most MAX_GROWTH times the work of one at an eighth of it, so a
 * quadratic walk is stopped at that much work instead of running to the end.
 */
export async function expectLinearWork(prepare: (size: number) => () => unknown, topSize: number): Promise<number> {
  const small = await countWork(prepare(Math.floor(topSize / GROWTH)));
  const large = await countWork(prepare(topSize), small * MAX_GROWTH);
  return large / small;
}
