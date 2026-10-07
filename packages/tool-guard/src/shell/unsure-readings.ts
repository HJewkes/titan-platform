import { caseNamed } from "./case-script.js";
import type { Unwrapped } from "./unwrap.js";

/** Words of `unsure` readings one line may walk; classifying costs about 50 ms per KiB, ten times that for a dynamic command word. */
export const MAX_UNSURE_WORDS = 512;

/** A line whose dynamic wrapper words leave more readings that may decide than the budget walks; the hook denies it unchecked. */
export class ReadingLimitError extends Error {
  constructor() {
    super("too many readings of dynamic wrapper words to check");
    this.name = "ReadingLimitError";
  }
}

/**
 * Bytes of shell script one line may classify, across every reading of it. A 64 KiB script costs about 1.6 s with case
 * folding on, so distinct scripts behind dynamic wrapper words would otherwise pass the 5 s hook timeout.
 */
export const MAX_SCRIPT_BYTES = 64 * 1024;

/**
 * What a byte of script or interpreter text costs when only an added reading runs it, where main reads none of it. Through
 * the hook on a real filesystem with case folding on, the costliest text (`$b x`, `eval $b x`) takes about 31 ms per KiB,
 * so the 16 KiB this leaves one script stays near 0.5 s.
 */
export const ADDED_SCRIPT_WEIGHT = 4;

/** The script whose text would take a line past `MAX_SCRIPT_BYTES`. */
export interface ScriptOverrun {
  /** The script's file name. */
  script: string;
  /** Its text, before any weight. */
  bytes: number;
  /** Whether only an added reading runs it, so its text costs `ADDED_SCRIPT_WEIGHT` per byte. */
  added: boolean;
  /** What the line's scripts would cost with it. */
  total: number;
}

/** A line whose scripts hold more text than `MAX_SCRIPT_BYTES`; the hook denies it unchecked, as past the reading budget. */
export class ScriptBudgetError extends ReadingLimitError {
  constructor(readonly overrun: ScriptOverrun) {
    super();
    this.message = "too much script text to check";
    this.name = "ScriptBudgetError";
  }
}

export interface UnsureBudget {
  left: number;
  /** Whether classify reads this command other than by its arguments' default treatment: a dynamic, guarded or exempting name. */
  decides: (cmd: Unwrapped) => boolean;
}

/**
 * Every reading of a command's `unsure` words that may decide, then theirs in turn, since each wrapper may hide its own
 * dynamic word (`sudo $a timeout $O 5 git push`). Dropping a word is not monotone: when it really is a wrapper's value
 * (`timeout $P git push`), a later reading moves `git` into the value slot, so no reading stands in for another.
 * A reading's arguments are a suffix of the command's as written, so it adds nothing only when both its name and
 * the written one get every family's default treatment (`flock $F ls sort key` runs `sort`, which `ls` hid). Such a
 * reading is skipped for free; any other is walked, or throws when the line's budget cannot cover it.
 */
export function unsureReadings(cmd: Unwrapped | undefined, budget: UnsureBudget): Unwrapped[][] {
  const out: Unwrapped[][] = [];
  const special = cmd !== undefined && cmd.name !== null && budget.decides(cmd);
  for (let unsure = cmd?.unsure; unsure; ) {
    const runs = caseNamed(unsure);
    if (special || runs.some(budget.decides)) {
      if (unsure.length > budget.left) throw new ReadingLimitError();
      budget.left -= unsure.length;
      out.push(runs);
    }
    unsure = runs[0]?.unsure;
  }
  return out;
}
