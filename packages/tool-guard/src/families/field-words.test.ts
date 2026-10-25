import { describe, expect, it } from "vitest";
import { tokenize, type WordToken } from "../shell/lexer.js";
import { expandsAtRunTime, literalKey } from "./field-words.js";

const word = (src: string) => tokenize(src)[0] as WordToken;

describe("expandsAtRunTime reads only characters outside quotes", () => {
  it.each([
    ["a quoted GraphQL selection after a bare key", "query='{viewer{login}}'", false],
    ["a quoted list type after a bare key", "query='[ID!]'", false],
    ["a glob character quoted between bare text", 'a"*"b', false],
    ["a variable inside single quotes", "'$X'", false],
    ["a double-quoted variable, which neither splits nor globs", '"$X"', false],
    ["a bare brace list", "query={a,b}", true],
    ["a bare glob after a quoted key", "'query='*", true],
    ["a bare tilde after the key's =", "query=~", true],
    ["a bare glob before a quoted part", 'a*"b"', true],
    ["a bare = leading a spliced word", "=ls'x'", true],
    ["a bare brace list after an escape", "\\q{a,b}", true],
  ])("%s: %s reads %s", (_scenario, src, expands) => {
    expect(expandsAtRunTime(word(src))).toBe(expands);
  });

  it("reads a quoted = leading a spliced word as literal, which zsh never expands as =cmd", () => {
    expect(expandsAtRunTime(word("'='ls"))).toBe(false);
  });

  it("reads a bare = after a quoted lead as literal, since zsh expands =cmd only at a word's start", () => {
    expect(expandsAtRunTime(word("'x'=ls"))).toBe(false);
  });

  it("counts a spliced word as bare throughout once its value is rewritten after lexing", () => {
    const quoted = word("query='{viewer{login}}'");

    expect(expandsAtRunTime({ ...quoted, value: quoted.value.slice(1) })).toBe(true);
  });

  it("keeps a field's key when only its quoted value holds braces", () => {
    expect(literalKey(word("query='query{viewer{login}}'"))).toBe("query");
  });
});
