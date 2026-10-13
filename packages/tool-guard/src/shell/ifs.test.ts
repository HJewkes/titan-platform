import { describe, expect, it } from "vitest";
import { ifsChanged, namesIfs, splittingWords } from "./ifs.js";
import { tokenize } from "./lexer.js";
import type { WordToken } from "./lexer.js";
import type { Vars } from "./vars.js";

const words = (src: string) => tokenize(src).filter((t): t is WordToken => t.type === "word");
const splitting = (src: string) => [...splittingWords(words(src))];
const singleQuoted = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const nestedEvals = (line: string, levels: number): string =>
  levels === 0 ? line : nestedEvals(`eval ${singleQuoted(line)}`, levels - 1);

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

  it("skips a computed word even when it carries refs", () => {
    const [, word] = words("echo ${E%x}");
    expect(word?.computed).toBe(true);
    expect(splitting("echo ${E%x}")).toEqual([]);
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

  it.each([
    ["an escaped letter", "declare I\\FS=,"],
    ["an empty quote pair", "read I''FS"],
    ["a quoted letter", 'export "I"FS=,'],
    ["a line continuation", "IF\\\nS=,"],
    ["an ANSI-C escape", "declare $'\\x49FS=,'"],
    ["printf -v with an escape", "printf -v I\\FS %s ,"],
    ["a brace list", "read {I,}FS"],
    ["a brace range", "read {H..J}FS"],
    ["an eval text that unquotes to IFS", "eval 'I\\FS=,'"],
    ["a command substitution", "x=$(read I\\FS)"],
  ])("matches IFS spelled with %s", (_form, line) => {
    expect(namesIfs(line)).toBe(true);
  });

  it("does not match a line without IFS", () => {
    expect(namesIfs("git push origin x")).toBe(false);
    expect(namesIfs("echo {I,J}{F,G} 'I'F")).toBe(false);
  });

  it.each([
    ["an escaped closing brace", "declare {I,\\}}FS=,"],
    ["an escaped opening brace", "declare {I,\\{}FS=,"],
    ["a double-quoted brace", 'declare {I,"}"}FS=,'],
    ["a single-quoted brace", "declare {I,'{'}FS=,"],
  ])("matches a brace list with %s as an item", (_form, line) => {
    expect(namesIfs(line)).toBe(true);
  });

  it.each([4, 7, 8, 12])("matches an escaped IFS under %i nested evals", (levels) => {
    expect(namesIfs(nestedEvals("declare I\\FS=,", levels))).toBe(true);
  });

  it("fails closed fast on a brace list whose expansion would be huge", () => {
    const items = Array.from({ length: 250 }, (_, i) => `a${i}`).join(",");
    const started = performance.now();

    const named = namesIfs(`echo {${items}}{\u0001..￿}`);

    expect(named).toBe(true);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it.each([
    ["names joined from variables", "c=S; b=F; a=I; declare $a$b$c=,"],
    ["a case-changing expansion", "x=ifs; declare ${x^^}=,"],
    ["a command substitution as the name", "declare \"$(printf '\\x49FS')\"=,"],
    ["a substitution inside the name", "declare I$(echo F)S=,"],
    ["a function body before the write", "R=origin,HEAD:main; f(){ git push $R; }; c=S; b=F; a=I; declare $a$b$c=,; f"],
    ["a run-time read option word", "read $opt line"],
    ["eval of run-time text", 'eval "$a$b$c=,"'],
    ["let of run-time text", "let $n=1"],
    ["arithmetic of run-time text", "(( $n = 1 ))"],
    ["a run-time command word", "$c $a$b$c=,"],
    ["builtin before the writer", "builtin declare $a=,"],
    ["a declare nameref to a run-time target", "declare -n R=$a$b; R=,"],
    ["a local nameref to a run-time target", "f(){ local -n R=$a$b; R=,; }"],
    ["a typeset nameref to a run-time target", "typeset -n R=$a$b; R=,"],
    ["a bare nameref bound later", "declare -n R; R=$a$b; R=,"],
    ["wait -p", "wait -p $a$b"],
    ["compgen -V", "compgen -V $a$b w"],
    ["zsh print -v", "print -v $a$b ,"],
    ["zsh set -A", "set -A $a$b ,"],
    ["zsh vared", "vared $a$b"],
    ["zsh zparseopts", "zparseopts a=$a$b"],
    ["zsh private", "private $a$b=,"],
    ["zsh sysread", "sysread $a$b"],
    ["zsh strftime -s", "strftime -s $a$b %s 0"],
    ["an option word the table cannot read", "declare -Q $a"],
  ])("matches a write whose name is built at run time: %s", (_form, line) => {
    expect(namesIfs(line)).toBe(true);
  });

  it.each([
    ["read ?", "read -r ?FS <<< ,"],
    ["read [ ]", "read [I]FS <<< ,"],
    ["read *", "read *FS <<< ,"],
    ["read -a", "read -a ?FS <<< ,"],
    ["printf -v", "printf -v ?FS %s ,"],
    ["unset", "unset ?FS"],
    ["mapfile", "mapfile -t *FS < list"],
    ["getopts", "getopts ab ?FS"],
    ["declare", "declare ?FS=,"],
    ["read -a with the name attached", "read -a?FS <<< ,"],
    ["read -ra with the name attached", "read -ra?FS <<< ,"],
    ["printf -v with the name attached", "printf -v?FS %s ,"],
  ])("matches a glob in the name slot of %s", (_form, line) => {
    expect(namesIfs(line)).toBe(true);
  });

  it.each([
    ["a globbed read", "rea? ?FS <<< ,"],
    ["a bracketed declare", "de[c]lare $a$b=,"],
    ["a braced read", "{rea,}d ?FS <<< ,"],
  ])("matches a command word that globs into a writer: %s", (_form, line) => {
    expect(namesIfs(line)).toBe(true);
  });

  it.each([
    ["arithmetic expansion", ": $(( $a$b=1 ))"],
    ["a substring offset", "echo ${x:$a$b=1}"],
    ["an indexed subscript", "arr[$a$b=1]=x"],
    ["a [[ ]] arithmetic test", "[[ 1 -eq $a$b ]]"],
    ["source", "source ./env.sh"],
    ["dot", ". ./env.sh"],
  ])("matches run-time arithmetic or a sourced file: %s", (_form, line) => {
    expect(namesIfs(line)).toBe(true);
  });

  it.each([
    "read -r line",
    "read -r -p 'Name: ' n",
    "declare -n R=target; R=x",
    "echo $((i + 1)) ${x:-$y} ${s:2}",
    "[[ $x == y ]]",
    "cd $dir",
    "cd .. && ls ./src",
    'export PATH="$HOME/bin:$PATH"',
    "declare X=$(date) Y=${z^^}",
    "for f in *.txt; do echo $f; done",
    "printf '%s\\n' $x",
    "git push origin $R",
    "cd $dir && ls *.ts",
    "mapfile -t lines < <(ls $d)",
    "unset -f my-func",
  ])("does not match a write whose name is literal: %s", (line) => {
    expect(namesIfs(line)).toBe(false);
  });

  it("reads 64KB under 8 nested evals in under 200 ms", () => {
    const line = nestedEvals(`echo ${"$a ".repeat(21_000)}; declare $a$b$c=,`, 8);
    const started = performance.now();

    const named = namesIfs(line);

    expect(line.length).toBeGreaterThan(64 * 1024);
    expect(named).toBe(true);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("does not match a numeric range", () => {
    expect(namesIfs("for i in {1..10}; do echo $i; done")).toBe(false);
  });

  it("matches a line that fails to parse once it holds I, F and S in order", () => {
    expect(namesIfs("echo 'I")).toBe(false);
    expect(namesIfs("I\\FS=, echo 'x")).toBe(true);
  });
});
