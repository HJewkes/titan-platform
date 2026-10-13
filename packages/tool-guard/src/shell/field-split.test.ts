import { describe, expect, it } from "vitest";
import { markCase } from "./case-attrs.js";
import { splitReading } from "./field-split.js";
import { tokenize } from "./lexer.js";
import type { WordToken } from "./tokens.js";
import { trackVars } from "./vars.js";
import type { Vars } from "./vars.js";

const words = (src: string) => tokenize(src).filter((t): t is WordToken => t.type === "word");

function read(src: string, values: Record<string, string | null>, home: string | null = null) {
  return splitReading(words(src), new Map(Object.entries(values)), home);
}

const values = (reading: WordToken[] | null) => reading?.map((w) => w.value) ?? null;

describe("splitReading reads a known unquoted expansion as bash field-splits it", () => {
  it.each([
    ["a whole subcommand", "git $X", { X: "push origin HEAD:main" }, ["git", "push", "origin", "HEAD:main"]],
    ["literal text joined to the first field", "git a$X", { X: "push origin HEAD:main" }, ["git", "apush", "origin", "HEAD:main"]],
    ["literal text joined to the last field", "git $X:main", { X: "push origin HEAD" }, ["git", "push", "origin", "HEAD:main"]],
    ["the command word itself", "$C", { C: "git push origin HEAD:main" }, ["git", "push", "origin", "HEAD:main"]],
    ["an empty value dropped as a field", "git $E push origin HEAD:main", { E: "" }, ["git", "push", "origin", "HEAD:main"]],
    ["a blank-only value dropped as a field", "git $E push", { E: " \t" }, ["git", "push"]],
    ["leading and trailing blanks", "git $X", { X: "  push   origin  " }, ["git", "push", "origin"]],
    ["two refs in one word", "git $A$B", { A: "push or", B: "igin main" }, ["git", "push", "origin", "main"]],
    ["HOME from the walk's home", "ls $HOME", {}, ["ls", "/srv/a", "b"]],
    ["the default IFS assigned", "git $X", { IFS: " \t\n", X: "push origin" }, ["git", "push", "origin"]],
    ["env, which is no declarer", "env Y=$X git", { X: "a b" }, ["env", "Y=a", "b", "git"]],
  ])("splits %s", (_name, src, vars, expected) => {
    expect(values(read(src, vars, "/srv/a b"))).toEqual(expected);
  });

  it("gives each field a literal value with the word as typed", () => {
    const [, field] = read("git $X", { X: "push origin" }) ?? [];
    expect(field).toMatchObject({ value: "push", dynamic: false, refs: [], typed: "$X" });
  });

  it("keeps the other words as expandWord gives them", () => {
    const reading = read('git $X "$Y" $Z', { X: "push origin", Y: "a b", Z: "c" });
    expect(values(reading)).toEqual(["git", "push", "origin", "a b", "c"]);
  });
});

describe("splitReading leaves a word it cannot split exactly raw and dynamic", () => {
  const raw = (reading: WordToken[] | null, i: number) => reading?.[i];

  it.each([
    ["a mixed-quote word", 'git "a"$X', { X: "push origin" }],
    ["a quoted empty beside an empty value", 'git ""$E', { E: "" }],
    ["a custom IFS", "git $X", { IFS: ":", X: "push:origin:HEAD:main" }],
    ["an unknown IFS", "git $X", { IFS: null, X: "push" }],
    ["an empty IFS", "git $X", { IFS: "", X: "push origin" }],
  ])("%s", (_name, src, vars) => {
    expect(raw(read(src, vars), 1)).toMatchObject({ dynamic: true, refs: [{ name: expect.any(String) }] });
  });

  it("a value a case attribute may change", () => {
    const vars: Vars = new Map([["X", "Push origin"]]);
    markCase(vars, "X", "l");
    expect(splitReading(words("git $X"), vars, null)?.[1]).toMatchObject({ dynamic: true, value: "$X" });
  });

  it.each([
    ["a value IFS=: would split", "push:origin"],
    ["a value only the default IFS would split", "push origin"],
  ])("%s, after a declaration that may have set IFS", (_name, value) => {
    const vars: Vars = new Map();
    trackVars({ name: "declare", args: words('"$(printf IFS=:)"'), assigned: [] }, vars);
    vars.set("X", value);
    expect(splitReading(words("git $X"), vars, null)?.[1]).toMatchObject({ dynamic: true, value: "$X" });
  });
});

describe("splitReading does not split assignments", () => {
  it.each([
    ["a prefix assignment", "Y=$X git status"],
    ["an export argument", "export Y=$X"],
    ["a declare argument after an option", "declare -x Y=$X"],
    ["a declaration behind time", "time export Y=$X"],
    ["a declaration behind time -p", "time -p readonly Y=$X"],
  ])("%s", (_name, src) => {
    expect(read(src, { X: "a b" })).toBeNull();
  });

  it.each([
    ["behind command", "command export Y=$X", ["command", "export", "Y=a", "b"]],
    ["behind builtin", "builtin export Y=$X", ["builtin", "export", "Y=a", "b"]],
    ["behind command -p", "command -p export Y=$X", ["command", "-p", "export", "Y=a", "b"]],
    ["with an escaped name", "\\export Y=$X", ["export", "Y=a", "b"]],
    ["with a quoted name", '"export" Y=$X', ["export", "Y=a", "b"]],
  ])("splits a declaration's assignment argument %s, as bash does", (_name, src, expected) => {
    expect(values(read(src, { X: "a b" }))).toEqual(expected);
  });

  it("still splits a declarer's non-assignment argument", () => {
    expect(values(read("export $X", { X: "A B" }))).toEqual(["export", "A", "B"]);
  });
});

describe("splitReading returns null when nothing splits differently", () => {
  it.each([
    ["a value with no blank", "git push origin $X", { X: "feat" }],
    ["a quoted value with blanks", 'git push origin "$X"', { X: "a b" }],
    ["an unknown value", "git push origin $X", {}],
    ["no expansion at all", "git push origin feat", {}],
    ["a command substitution", "git push origin $(echo a b)", {}],
    ["a custom IFS with no expansion", "git push", { IFS: ":" }],
  ])("%s", (_name, src, vars) => {
    expect(read(src, vars)).toBeNull();
  });
});
