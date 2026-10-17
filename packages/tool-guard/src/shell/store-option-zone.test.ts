import { describe, expect, it } from "vitest";
import type { WordToken } from "./lexer.js";
import { tokenize } from "./lexer.js";
import { expandsInStoreOptions } from "./store-option-zone.js";

const inOptions = (src: string) => {
  const [name, ...args] = tokenize(src).filter((t): t is WordToken => t.type === "word");
  if (!name) throw new Error(`no command in ${src}`);
  return expandsInStoreOptions(name.value, args);
};

describe("read's letters that take a value in bash and are a flag in zsh", () => {
  it.each([
    ["zsh read -n, a flag, before a word that may be -A NAME", 'read -n "$x"'],
    ["zsh read -t, a flag", 'read -t "$x"'],
    ["zsh read -p, a flag", 'read -p "$x" line'],
    ["zsh read -k, which takes only an attached number", 'read -k "$x"'],
    ["an either letter last in a cluster", 'read -rn "$x"'],
    ["bash read -n then a word in option position", 'read -n 1 "$x"'],
    ["bash read -n taking -u, then a word in option position", 'read -n -u "$x"'],
    ["zsh read -n then -u, whose unquoted value may split", "read -n -u $fd line"],
  ])("is caught: %s", (_how, src) => {
    expect(inOptions(src)).toBe(true);
  });

  it.each([
    ["a quoted value after a letter both shells read as one", 'read -d "$d" line'],
    ["a literal name after an either letter", "read -n line"],
    ["a word after --", 'read -r -- "$x"'],
    ["an either letter with its value attached", 'read -n1 line "$x"'],
  ])("is left alone: %s", (_how, src) => {
    expect(inOptions(src)).toBe(false);
  });
});
