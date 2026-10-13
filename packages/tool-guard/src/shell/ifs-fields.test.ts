import { describe, expect, it } from "vitest";
import { hasIfsChar, ifsFields, type WordPart } from "./ifs-fields.js";

const lit = (text: string): WordPart => ({ text, splits: false });
const exp = (text: string): WordPart => ({ text, splits: true });

const DEFAULT_IFS = " \t\n";

describe("ifsFields matches bash 5's field splitting under a custom IFS", () => {
  it.each<[string, string, WordPart[], string[]]>([
    ["1: commas split a command", ",", [exp("gh,pr,merge,1")], ["gh", "pr", "merge", "1"]],
    ["2: a refspec keeps its colon", ",", [exp("git,push,origin,HEAD:main")], ["git", "push", "origin", "HEAD:main"]],
    ["3: a lone delimiter is one empty field", ",", [exp(",")], [""]],
    ["4: a leading delimiter starts with an empty field", ",", [exp(",a")], ["", "a"]],
    ["5: a trailing delimiter adds no empty field", ",", [exp("a,")], ["a"]],
    ["6: adjacent delimiters keep an empty field between", ",", [exp("a,,b")], ["a", "", "b"]],
    ["7: two trailing delimiters keep one empty field", ",", [exp("a,,")], ["a", ""]],
    ["8: two delimiters alone are two empty fields", ",", [exp(",,")], ["", ""]],
    ["9: a space is no delimiter when IFS lacks it", ",", [exp("gh pr,merge")], ["gh pr", "merge"]],
    ["10: an empty value yields no field", ",", [exp("")], []],
    ["11: whitespace around a comma joins it", ", ", [exp("a , b")], ["a", "b"]],
    ["12: a comma, a blank, a comma keeps an empty field", ", ", [exp("a, ,b")], ["a", "", "b"]],
    ["13: a leading blank then comma is one empty field", ", ", [exp(" ,a")], ["", "a"]],
    ["14: a run of blanks is one delimiter", ", ", [exp("a  b")], ["a", "b"]],
    ["15: leading and trailing blanks are dropped", ", ", [exp(" a ")], ["a"]],
    ["16: a trailing blank then comma adds no empty field", ", ", [exp("a ,")], ["a"]],
    ["17: literal text joins the first and last fields", ":", [lit("x"), exp("a:b"), lit("y")], ["xa", "by"]],
    ["18: a delimiter after literal text ends the word", ",", [lit("x"), exp(",")], ["x"]],
    ["19: a delimiter before literal text keeps an empty field", ",", [exp(","), lit("y")], ["", "y"]],
    ["20: a trailing delimiter splits from literal text after it", ",", [exp("a,"), lit("b")], ["a", "b"]],
    ["21: an empty IFS never splits", "", [exp("a b,c")], ["a b,c"]],
    ["22: an empty IFS and value yield no field", "", [exp("")], []],
    ["23: a tab IFS splits on tab only", "\t", [exp("a\tb c")], ["a", "b c"]],
    ["24: delimiters from two expansions both count", ",", [exp("a,"), exp(",b")], ["a", "", "b"]],
    ["25: a literal IFS character never splits", ",", [lit("a,"), exp("b")], ["a,b"]],
    ["26: an empty expansion before a value adds nothing", ",", [exp(""), exp("a,b")], ["a", "b"]],
  ])("row %s", (_row, ifs, parts, fields) => {
    expect(ifsFields(parts, ifs)).toEqual(fields);
  });
});

describe("ifsFields treats \\r, \\f and \\v in IFS as whitespace, as bash 5.3 does", () => {
  it.each(["\r", "\f", "\v"])("drops leading, internal and trailing runs of %j", (c) => {
    expect(ifsFields([exp(`${c}a${c}${c}b${c}`)], c)).toEqual(["a", "b"]);
    expect(ifsFields([exp(`${c}${c}git${c}push${c}${c}`)], c)).toEqual(["git", "push"]);
  });

  it.each(["\r", "\f", "\v"])("joins %j around a comma into one delimiter", (c) => {
    expect(ifsFields([exp(`a${c},${c}b`)], `,${c}`)).toEqual(["a", "b"]);
  });
});

describe("ifsFields keeps the field a quoted part makes, even an empty one", () => {
  const quoted = (text: string): WordPart => ({ text, splits: false, quoted: true });

  it.each<[string, string, WordPart[], string[]]>([
    ['$v"" with v="a,"', ",", [exp("a,"), quoted("")], ["a", ""]],
    ['""$e with an empty e', ",", [quoted(""), exp("")], [""]],
    ['"$e" with an empty e', ",", [quoted("")], [""]],
    ['$e"" with e=" a "', DEFAULT_IFS, [exp(" a "), quoted("")], ["a", ""]],
    ['""$e with e=" a "', DEFAULT_IFS, [quoted(""), exp(" a ")], ["", "a"]],
    ['""$e with e=",a"', ",", [quoted(""), exp(",a")], ["", "a"]],
    ["an unquoted empty literal", ",", [lit(""), exp("")], []],
  ])("%s", (_how, ifs, parts, fields) => {
    expect(ifsFields(parts, ifs)).toEqual(fields);
  });
});

describe("ifsFields refuses a non-ASCII IFS, which bash splits by bytes", () => {
  it.each<[string, string, string]>([
    ["a blank plus multibyte characters", " ã©", "gh é pr é merge é 1"],
    ["multibyte characters alone (C locale)", "ã©", "ghéprémergeé1"],
  ])("returns null for %s", (_how, ifs, value) => {
    expect(ifsFields([exp(value)], ifs)).toBeNull();
  });

  it("still splits the same command under an ASCII IFS", () => {
    expect(ifsFields([exp("gh,pr,merge,1")], ",")).toEqual(["gh", "pr", "merge", "1"]);
  });

  it("reports a possible split for any text, so a caller does not skip it", () => {
    expect(hasIfsChar("ghéprémergeé1", "ã©")).toBe(true);
    expect(hasIfsChar("ghéprémergeé1", ",")).toBe(false);
  });
});

describe("ifsFields under the default IFS", () => {
  it.each<[string, WordPart[], string[]]>([
    ["drops leading and trailing blanks", [exp("  push   origin  ")], ["push", "origin"]],
    ["yields no field for an empty value", [exp("")], []],
    ["joins literal text to the first field", [lit("a"), exp("push origin")], ["apush", "origin"]],
    ["splits on tabs and newlines", [exp("push\torigin\nmain")], ["push", "origin", "main"]],
    ["never splits a literal blank", [lit("a b"), exp("c")], ["a bc"]],
  ])("%s", (_how, parts, fields) => {
    expect(ifsFields(parts, DEFAULT_IFS)).toEqual(fields);
  });
});

describe("hasIfsChar", () => {
  it.each<[string, string, boolean]>([
    ["a,b", ",", true],
    ["a b", ",", false],
    ["x", "", false],
    ["a b", DEFAULT_IFS, true],
  ])("finds an IFS character in %j under %j: %s", (text, ifs, found) => {
    expect(hasIfsChar(text, ifs)).toBe(found);
  });
});
