import { SplitParseError, tokenize } from "./lexer.js";
import type { Token } from "./lexer.js";
import { NestingLimitError } from "./nesting.js";
import { NestingReadingError, SplitReadingError } from "./unsure-readings.js";

/** A line bash 5 and bash 3.2 read differently is refused outright, whatever it names; a plain ParseError is not. */
export function tokenizeLine(src: string): Token[] {
  try {
    return tokenize(src);
  } catch (error) {
    if (error instanceof SplitParseError) throw new SplitReadingError(error.split);
    if (error instanceof NestingLimitError) throw new NestingReadingError();
    throw error;
  }
}
