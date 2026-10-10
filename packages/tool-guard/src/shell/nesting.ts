/** Deepest nesting of expansions and substitutions the readers recurse through; bash use stays far below it. */
export const MAX_NESTING = 100;

/** How deep the readers of one command are, shared like its reading budget. */
export interface Nesting {
  depth: number;
}

/** Not a ParseError, so no reader's fallback swallows it; the shell walk turns it into a reading limit the hook denies. */
export class NestingLimitError extends Error {
  override name = "NestingLimitError";

  constructor() {
    super(`expansions nested more than ${MAX_NESTING} deep`);
  }
}

/** Runs one nested read, refusing past `MAX_NESTING` before the recursion can overflow the stack. */
export function nested<T>(nesting: Nesting, read: () => T): T {
  if (nesting.depth >= MAX_NESTING) throw new NestingLimitError();
  nesting.depth++;
  try {
    return read();
  } finally {
    nesting.depth--;
  }
}
