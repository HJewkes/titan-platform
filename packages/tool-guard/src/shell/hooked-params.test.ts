import { describe, expect, it } from "vitest";
import { writesHookedParam } from "./hooked-params.js";
import { tokenize } from "./lexer.js";
import type { WordToken } from "./lexer.js";
import { unwrap } from "./unwrap.js";

const hooked = (line: string) => {
  const words = tokenize(line).filter((t): t is WordToken => t.type === "word");
  const cmd = unwrap(words);
  return cmd && writesHookedParam(cmd, words);
};

describe("a command that writes a parameter the shell later runs", () => {
  it.each([
    ["a bare assignment", "PS4='$(x)'", "PS4"],
    ["a prefix assignment", "PS4=x bash -xc true", "PS4"],
    ["an env assignment", "env PS4=x bash -xc true", "PS4"],
    ["an append", "PS4+=x", "PS4"],
    ["export", "export PS4='$(x)'", "PS4"],
    ["export after builtin", "builtin export PS4=x", "PS4"],
    ["zsh typeset of PROMPT4", "typeset -g PROMPT4=x", "PROMPT4"],
    ["a nameref to PS4", "declare -n R=PS4", "PS4"],
    ["zsh typeset -T of the tied pair", "typeset -T MODULE_PATH module_path", "MODULE_PATH"],
    ["read", "read -r PS4", "PS4"],
    ["zsh read -A", "read -A module_path", "module_path"],
    ["a for loop variable", "for PS4 in a", "PS4"],
    ["getopts", "getopts o PS4", "PS4"],
    ["mapfile", "mapfile module_path", "module_path"],
    ["printf -v", "printf -v PS4 x", "PS4"],
    ["printf -v attached", "printf -vPS4 x", "PS4"],
    ["zsh print -v", "print -v PS4 x", "PS4"],
    ["zsh set -A", "set -A module_path /tmp/m", "module_path"],
    ["zsh vared", "vared PS4", "PS4"],
    ["zsh zstyle -s", "zstyle -s c s PS4", "PS4"],
    ["a zsh array assignment", "module_path=(/tmp/m $module_path)", "module_path"],
    ["a zsh array append", "module_path+=(/tmp/m)", "module_path"],
    ["an element assignment", "module_path[1]=/tmp/m", "module_path"],
    ["the scalar tie", "MODULE_PATH=/tmp/m", "MODULE_PATH"],
    ["a default-assign expansion", ": ${PS4:=x}", "PS4"],
    ["a plain default-assign expansion", ": ${PS4=x}", "PS4"],
    ["a zsh array default-assign expansion", ": ${(A)module_path::=/tmp/m}", "module_path"],
    ["a default-assign in another assignment's value", "X=${PS4:=x}", "PS4"],
    ["a default-assign in a prefix assignment's value", "X=${PS4:=x} true", "PS4"],
    ["a default-assign of an element", ": ${PS4[0]:='$(x)'}", "PS4"],
    ["a plain default-assign of an element", ": ${PS4[0]=x}", "PS4"],
    ["printf -v of an element", "printf -v PS4[0] x", "PS4"],
    ["printf -v of an element, attached", "printf -vPS4[0] x", "PS4"],
    ["zsh print -v of an element", "print -v PS4[1] x", "PS4"],
    ["a nameref to an element", "declare -n R=PS4[0]", "PS4"],
  ])("names it: %s", (_how, line, name) => {
    expect(hooked(line)).toBe(name);
  });
});

describe("a command that only reads or mentions a hooked name", () => {
  it.each([
    ["echo of PS4", "echo $PS4"],
    ["echo of braced PS4", "echo \"${PS4}\""],
    ["PS4 as another assignment's value", "X=$PS4 env"],
    ["a search", "rg PS4 src"],
    ["a grep for module_path", "grep module_path f"],
    ["a commit message", "git commit -m 'refuse PS4 writes'"],
    ["unset", "unset PS4"],
    ["let", "let PS4=1"],
    ["set -x", "set -x"],
    ["a stock zsh module", "zmodload zsh/datetime"],
    ["a longer name", "export PS5=x"],
    ["a nameref to a longer name", "declare -n R=PS44"],
    ["a default-assign of another name", ": ${X:=PS4}"],
    ["a quoted default-assign in a commit message", "git commit -m 'set ${PS4:=x}'"],
    ["a brace list that spells no hooked name", "read {a,b}"],
    ["printf of a sequence", "printf '%s\\n' {1..5}"],
  ])("returns null: %s", (_how, line) => {
    expect(hooked(line)).toBeNull();
  });
});

describe("a brace word in a command that names what it writes", () => {
  it.each([
    ["a brace list", "export {P,}S4=x", "{P,}S4=x"],
    ["a brace list in read", "read {P,}S4", "{P,}S4"],
    ["an escaped closing brace", "export {P,\\}}S4=x", "{P,}}S4=x"],
    ["a double-quoted closing brace", 'export {P,"}"}S4=x', "{P,}}S4=x"],
    ["a single-quoted closing brace", "export {P,'}'}S4=x", "{P,}}S4=x"],
    ["an escaped opening brace", "read {P,\\{}S4", "{P,{}S4"],
    ["an escaped opening brace first", "read {\\{,P}S4", "{{,P}S4"],
    ["an integer range for the digit", "read PS{1..9}", "PS{1..9}"],
    ["a letter range", "read {O..Q}S4", "{O..Q}S4"],
    ["zsh module_path through a brace list", "typeset -a {module,x}_path", "{module,x}_path"],
    ["a zsh braceccl character range", "typeset {O-Q}S4=x", "{O-Q}S4=x"],
  ])("counts as a hooked write: %s", (_how, line, word) => {
    expect(hooked(line)).toBe(word);
  });

  it("treats a brace word that also globs as a hooked write", () => {
    expect(hooked("read {a,b}*")).toBe("{a,b}*");
  });

  it("returns null when the word lacks a hooked name's characters in order", () => {
    expect(hooked("read {a,b}")).toBeNull();
    expect(hooked("printf '%s\\n' {1..5}")).toBeNull();
  });

  it("is not read in a command that writes no named parameter", () => {
    expect(hooked("echo {P,}S4")).toBeNull();
  });

  it("reads a 100 KB line of integer ranges without expanding it", () => {
    const words = tokenize(`read ${"{1..1000} ".repeat(10_000)}PS{4,}`).filter((t): t is WordToken => t.type === "word");
    const cmd = unwrap(words);
    const started = performance.now();

    const named = cmd && writesHookedParam(cmd, words);

    expect(named).toBe("PS{4,}");
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("a glob word in a command that names what it writes", () => {
  it.each([
    ["a ? in read", "read P?4", "P?4"],
    ["a * in read", "read P*4", "P*4"],
    ["a bracket expression in read", "read P[S]4", "P[S]4"],
    ["a negated bracket expression", "read P[!X]4", "P[!X]4"],
    ["a ? in export", "export P?4=x", "P?4=x"],
    ["a ? in printf -v", "printf -v P?4 x", "P?4"],
    ["a ? attached to printf -v", "printf -vP?4 x", "-vP?4"],
    ["a ? before a subscript", "read P?4[0]", "P?4[0]"],
    ["a lone *", "read *", "*"],
    ["a glob for module_path", "typeset -a mod*path", "mod*path"],
    ["a partly quoted glob", "read P'S'?", "PS?"],
  ])("counts as a hooked write: %s", (_how, line, word) => {
    expect(hooked(line)).toBe(word);
  });

  it.each([
    ["a glob that matches no hooked name", "read x?"],
    ["a glob in a printf operand", "printf '%s\\n' *.ts"],
    ["a fully quoted glob", "read 'P?4'"],
    ["a glob in a command that writes no named parameter", "ls P?4"],
  ])("returns null: %s", (_how, line) => {
    expect(hooked(line)).toBeNull();
  });

  it("fails closed on an option cluster too long to split", () => {
    expect(hooked("printf -abcdefghijP?4 x")).toBe("-abcdefghijP?4");
  });

  it("fails closed on a bracket expression regex cannot read", () => {
    expect(hooked("read P[z-a]4")).toBe("P[z-a]4");
  });

  it("fails closed fast on a glob with many stars", () => {
    const words = tokenize(`read ${"*?".repeat(5_000)}x`).filter((t): t is WordToken => t.type === "word");
    const cmd = unwrap(words);
    const started = performance.now();

    const named = cmd && writesHookedParam(cmd, words);

    expect(named).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
  });
});
