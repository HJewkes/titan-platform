import { describe, expect, it } from "vitest";
import { tokenize } from "./lexer.js";
import { notePathLine, onPathLine } from "./path-commands.js";
import type { WordToken } from "./lexer.js";

/** A linear reading takes a few milliseconds; a copy of the token tail per command word takes seconds at this size. */
const BUDGET_MS = 300;

const wordsOf = (tokens: ReturnType<typeof tokenize>) => tokens.filter((t): t is WordToken => t.type === "word");

describe("reading a long line for commands that rebind wc", () => {
  it("marks every word of a line of many commands in time linear in its length, with a declarer at the end", () => {
    const tokens = tokenize(`${": ;".repeat(20000)} declare -x r=1`);
    const start = performance.now();
    notePathLine(tokens);
    const elapsed = performance.now() - start;
    expect(wordsOf(tokens).every(onPathLine)).toBe(true);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});
