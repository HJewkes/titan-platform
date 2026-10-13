import { describe, expect, it } from "vitest";
import { ifsChanged, namesIfs, splittingWords } from "./ifs.js";
import { tokenize } from "./lexer.js";
import type { WordToken } from "./lexer.js";
import type { Vars } from "./vars.js";

const words = (src: string) => tokenize(src).filter((t): t is WordToken => t.type === "word");
const splitting = (src: string) => [...splittingWords(words(src))];

describe("splittingWords", () => {
  it("marks an unquoted variable expansion", () => {
    expect(splitting("gh api $E")).toEqual([2]);
  });

  it("skips a double-quoted expansion, whole or after a literal", () => {
    expect(splitting('gh api "$E"')).toEqual([]);
    expect(splitting('gh api a"$E"')).toEqual([]);
  });

  it("marks an expansion outside quotes even when part of the word is quoted", () => {
    expect(splitting('gh api "a"$E')).toEqual([2]);
  });

  it("skips the leading assignment run but not a later NAME= argument", () => {
    expect(splitting("X=$E Y=$F gh api $E")).toEqual([4]);
    expect(splitting("export X=$E")).toEqual([1]);
  });

  it("skips computed words, which already read as run time", () => {
    expect(splitting("echo $((1+2)) $(cat f)")).toEqual([]);
  });

  it("skips literal words", () => {
    expect(splitting("git push origin main")).toEqual([]);
  });
});

describe("ifsChanged", () => {
  const vars = (entries: Array<[string, string | null]>): Vars => new Map(entries);

  it("is true for a custom separator", () => {
    expect(ifsChanged(vars([["IFS", ","]]))).toBe(true);
  });

  it("is true for a write the walk could not read", () => {
    expect(ifsChanged(vars([["IFS", null]]))).toBe(true);
  });

  it("is true for an empty IFS, which turns splitting off but is still not the default", () => {
    expect(ifsChanged(vars([["IFS", ""]]))).toBe(true);
  });

  it("is false when IFS was never written or holds the default", () => {
    expect(ifsChanged(vars([]))).toBe(false);
    expect(ifsChanged(vars([["IFS", " \t\n"]]))).toBe(false);
  });
});

describe("namesIfs", () => {
  it("matches IFS anywhere in the text", () => {
    expect(namesIfs("while IFS= read -r l; do :; done")).toBe(true);
    expect(namesIfs('declare "OLDIFS=$IFS"')).toBe(true);
  });

  it("does not match a line without IFS", () => {
    expect(namesIfs("git push origin x")).toBe(false);
  });
});
