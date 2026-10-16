import { describe, expect, it } from "vitest";
import { tokenize } from "./lexer.js";

const arithOps = (src: string) =>
  tokenize(src).filter(
    (t) => t.type === "op" && t.value === "(" && t.arith === true
  ).length;

describe("lexer arithmetic marker", () => {
  it.each([
    "((1))",
    "((a[1<<2]))",
    "(( arr[1] ))",
    "for ((i=0;i<2;i++)); do :; done",
    "if ((x)); then :; fi",
  ])("marks the first paren of the arithmetic command in %s", (src) => {
    expect(arithOps(src)).toBe(1);
  });

  it("marks only the first of the two parens", () => {
    const ops = tokenize("((1))").flatMap((t) => (t.type === "op" ? [t] : []));
    expect(ops.map((t) => [t.value, t.arith])).toEqual([
      ["(", true],
      ["(", undefined],
      [")", undefined],
      [")", undefined],
    ]);
  });

  it.each(["( (git push) )", "((git push) )", "((1", "echo $((1))"])(
    "leaves %s unmarked",
    (src) => {
      expect(arithOps(src)).toBe(0);
    }
  );
});
