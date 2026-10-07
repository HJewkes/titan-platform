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

export interface UnsureBudget {
  left: number;
  /** Whether classify may draw a verdict from a reading run as this command. */
  decides: (cmd: Unwrapped) => boolean;
}

/**
 * Every reading of a command's `unsure` words that may decide, then theirs in turn, since each wrapper may hide its own
 * dynamic word (`sudo $a timeout $O 5 git push`). Dropping a word is not monotone: when it really is a wrapper's value
 * (`timeout $P git push`), a later reading moves `git` into the value slot, so no reading stands in for another. A reading
 * that cannot decide is skipped for free; one that can is walked, or throws when the line's budget cannot cover it.
 */
export function unsureReadings(cmd: Unwrapped | undefined, budget: UnsureBudget): Unwrapped[][] {
  const out: Unwrapped[][] = [];
  for (let unsure = cmd?.unsure; unsure; ) {
    const runs = caseNamed(unsure);
    if (runs.some(budget.decides)) {
      if (unsure.length > budget.left) throw new ReadingLimitError();
      budget.left -= unsure.length;
      out.push(runs);
    }
    unsure = runs[0]?.unsure;
  }
  return out;
}
