import { describe, expect, it } from "vitest";
import { commandWordShape, literalValue } from "./literal-word.js";
import { type WordToken, tokenize } from "./lexer.js";

function word(src: string): WordToken {
  const first = tokenize(src)[0];
  if (first?.type !== "word") throw new Error(`no word in ${src}`);
  return first;
}

describe("literalValue", () => {
  it.each([
    ["=sh"],
    ["~g"],
    ["~1"],
    ["{a,b}"],
    ["''{a,b}"],
    ["[es]*"],
    ["^x"],
    ["x#"],
    ["a~b"],
    ["$=c"],
    ["$a"],
    ['"$a"'],
    ["$(ls)"],
  ])("reads %s as rewritten or run before a program sees it", (src) => {
    expect(literalValue(word(src))).toBeNull();
  });

  it.each([
    ["sh", "sh"],
    ["'=sh'", "=sh"],
    ['"{a,b}"', "{a,b}"],
    ["~", "~"],
    ["~/x", "~/x"],
    ["[", "["],
    ["[[", "[["],
    ["a=b", "a=b"],
  ])("reads %s as the literal %j", (src, value) => {
    expect(literalValue(word(src))).toBe(value);
  });
});

describe("commandWordShape", () => {
  it.each([['"$CC"'], ['"${CC}"'], ['"$HOME/bin/tool"']])("reads %s as one word", (src) => {
    expect(commandWordShape(word(src))).toEqual({ kind: "one" });
  });

  it.each([
    ["$CC"],
    ["$a"],
    ["$=c"],
    ['"${(f)x}"'],
    ['"${(s.:.)x}"'],
    ['"${a[@]}"'],
    ['"$@"'],
    ["$(ls)"],
    ["{a,b}"],
    ['"$CC"*'],
  ])("reads %s as possibly several words", (src) => {
    expect(commandWordShape(word(src))).toEqual({ kind: "many" });
  });

  it("reads =zsh as the program zsh, which EQUALS finds on PATH", () => {
    expect(commandWordShape(word("=zsh"))).toEqual({ kind: "literal", name: "zsh" });
  });

  it("reads a plain word as literal", () => {
    expect(commandWordShape(word("git"))).toEqual({ kind: "literal", name: "git" });
  });
});
