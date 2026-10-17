import { newTrials } from "./arith-trials.js";
import { SplitParseError, tokenize } from "./lexer.js";
import type { Token } from "./lexer.js";
import { NestingLimitError } from "./nesting.js";
import { NestingReadingError, SplitReadingError } from "./unsure-readings.js";
import { choosesStartup } from "./startup-file.js";
import { hasUnreadSteps } from "./unread-steps.js";

/** A line bash 5 and bash 3.2 read differently is refused outright, whatever it names; a plain ParseError is not. */
export function tokenizeLine(src: string, joinsConditional: boolean): { tokens: Token[]; joined: boolean } {
  try {
    const tokens = tokenize(src, newTrials(src, joinsConditional));
    // The joined reading is only trusted when every step in the text can be read and no shell on it sources a file
    // the line chose first: an unread step or such a file may have renamed `[[`.
    if (!joinsConditional || !(hasUnreadSteps(tokens) || choosesStartup(tokens))) return { tokens, joined: joinsConditional };
    return { tokens: tokenize(src, newTrials(src)), joined: false };
  } catch (error) {
    if (error instanceof SplitParseError) throw new SplitReadingError(error.split);
    if (error instanceof NestingLimitError) throw new NestingReadingError();
    throw error;
  }
}
