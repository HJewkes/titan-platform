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
    ["an export append", "export PS4+=x", "PS4"],
    ["export after builtin", "builtin export PS4=x", "PS4"],
    ["zsh typeset of PROMPT4", "typeset -g PROMPT4=x", "PROMPT4"],
    ["a nameref to PS4", "declare -n R=PS4", "PS4"],
    ["a nameref to an element", "declare -n R=PS4[0]", "PS4"],
    ["zsh typeset -T of the tied pair", "typeset -T MODULE_PATH module_path", "MODULE_PATH"],
    ["a quoted declared name", "export 'PS4'=x", "PS4"],
    ["read", "read -r PS4", "PS4"],
    ["read of an element", "read PS4[0]", "PS4"],
    ["zsh read -A", "read -A module_path", "module_path"],
    ["a zsh read prompt", "read 'PS4?Name: '", "PS4"],
    ["a for loop variable", "for PS4 in a", "PS4"],
    ["getopts", "getopts o PS4", "PS4"],
    ["mapfile", "mapfile module_path", "module_path"],
    ["printf -v", "printf -v PS4 x", "PS4"],
    ["printf -v attached", "printf -vPS4 x", "PS4"],
    ["printf -v of an element", "printf -v PS4[0] x", "PS4"],
    ["printf -v of an element, attached", "printf -vPS4[0] x", "PS4"],
    ["zsh print -v", "print -v PS4 x", "PS4"],
    ["zsh print -v in a cluster", "print -rv PS4 x", "PS4"],
    ["zsh print -v of an element", "print -v PS4[1] x", "PS4"],
    ["zsh set -A", "set -A module_path /tmp/m", "module_path"],
    ["zsh set +A", "set +A module_path /tmp/m", "module_path"],
    ["zsh vared", "vared PS4", "PS4"],
    ["zsh zstyle -s", "zstyle -s c s PS4", "PS4"],
    ["zsh strftime -s", "strftime -s PS4 %s 0", "PS4"],
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
  ])("names it: %s", (_how, line, name) => {
    expect(hooked(line)).toBe(name);
  });
});

describe("a name slot the shell computes", () => {
  it.each([
    ["an indirect prefix expansion", "read ${!PS@}", "${!PS@}"],
    ["a quoted indirect prefix expansion", 'read "${!PS@}"', "${!PS@}"],
    ["the keys of an array", 'read "${!m[@]}"', "${!m[@]}"],
    ["an arithmetic expansion", "read PS$((4))", "PS$((4))"],
    ["an arithmetic sum", "read PS$((2+2))", "PS$((2+2))"],
    ["a variable", 'read "$N"', "$N"],
    ["a variable before the =", 'export "$N"=x', "$N=x"],
    ["a command substitution before the =", "export $(echo PS4)=x", "=x"],
    ["a dynamic printf option", 'printf "$O" x', "$O"],
    ["a dynamic set option", "set $O", "$O"],
    ["a dynamic printf -v operand", 'printf -v "$N" x', "$N"],
    ["a brace list", "export {P,}S4=x", "{P,}S4=x"],
    ["a brace list in read", "read {P,}S4", "{P,}S4"],
    ["an escaped closing brace", "export {P,\\}}S4=x", "{P,}}S4=x"],
    ["a double-quoted closing brace", 'export {P,"}"}S4=x', "{P,}}S4=x"],
    ["a single-quoted closing brace", "export {P,'}'}S4=x", "{P,}}S4=x"],
    ["an escaped opening brace", "read {P,\\{}S4", "{P,{}S4"],
    ["an escaped opening brace first", "read {\\{,P}S4", "{{,P}S4"],
    ["an integer range", "read PS{1..9}", "PS{1..9}"],
    ["a zsh braceccl character range", "typeset {O-Q}S4=x", "{O-Q}S4=x"],
    ["a brace list that spells no hooked name", "read {a,b}", "{a,b}"],
    ["a ? glob", "read P?4", "P?4"],
    ["a * glob", "read P*4", "P*4"],
    ["a bracket expression", "read P[S]4", "P[S]4"],
    ["a subscript that globs to a hooked name", "read PS[4]", "PS[4]"],
    ["a POSIX character class", "read [[:upper:]]S4", "[[:upper:]]S4"],
    ["a POSIX equivalence class", "read [[=P=]]S4", "[[=P=]]S4"],
    ["a POSIX collating symbol", "read [[.P.]]S4", "[[.P.]]S4"],
    ["a glob in export", "export P?4=x", "P?4=x"],
    ["a glob that supplies the =", "export P?4?*", "P?4?*"],
    ["a glob that supplies the = in declare", "declare P?4?x", "P?4?x"],
    ["a glob that supplies a subscript", "read PS4?0?", "PS4?0?"],
    ["a glob in printf -v", "printf -v P?4 x", "P?4"],
    ["a glob attached to printf -v", "printf -vP?4 x", "P?4"],
    ["a partly quoted glob", "read P'S'?", "PS?"],
    ["a zsh ^ under extendedglob", "typeset ^X=x", "^X=x"],
    ["a zsh # under extendedglob", "read P#S4", "P#S4"],
    ["a zsh ~ under extendedglob", "read PS4~x", "PS4~x"],
  ])("counts as a hooked write: %s", (_how, line, slot) => {
    expect(hooked(line)).toBe(slot);
  });

  it("reads a 100 KB line of brace words without expanding them", () => {
    const words = tokenize(`read ${"{1..1000} ".repeat(10_000)}`).filter((t): t is WordToken => t.type === "word");
    const cmd = unwrap(words);
    const started = performance.now();

    const named = cmd && writesHookedParam(cmd, words);

    expect(named).toBe("{1..1000}");
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("a command that only reads, mentions or writes another name", () => {
  it.each([
    ["echo of PS4", "echo $PS4"],
    ["echo of braced PS4", "echo \"${PS4}\""],
    ["PS4 as another assignment's value", "X=$PS4 env"],
    ["a search", "rg PS4 src"],
    ["a grep for module_path", "grep module_path f"],
    ["a commit message", "git commit -m 'refuse PS4 writes'"],
    ["a quoted default-assign in a commit message", "git commit -m 'set ${PS4:=x}'"],
    ["unset", "unset PS4"],
    ["let", "let PS4=1"],
    ["set -x", "set -x"],
    ["set with options and an operand", "set -euo pipefail"],
    ["set -- with a glob", "set -- *"],
    ["a stock zsh module", "zmodload zsh/datetime"],
    ["a longer name", "export PS5=x"],
    ["a nameref to a longer name", "declare -n R=PS44"],
    ["a default-assign of another name", ": ${X:=PS4}"],
    ["a value that expands", "export PATH=~/bin:$PATH"],
    ["a value that globs", "export X=*"],
    ["a value holding #", "local x=a#b"],
    ["read of an element", "read arr[0]"],
    ["read with a literal prompt", "read -r -p 'Name? ' ans"],
    ["a fully quoted glob", "read 'P?4'"],
    ["printf operands that expand", "printf '%s\\n' {1..5} *.ts \"${a#b}\""],
    ["printf -v of another name", "printf -v out '%s' *"],
    ["mapfile with a count", "mapfile -n 5 lines"],
    ["getopts over the arguments", 'getopts "ab:" opt "$@"'],
    ["a glob in a command that writes no named parameter", "ls P?4"],
    ["a brace word in a command that writes no named parameter", "echo {P,}S4"],
  ])("returns null: %s", (_how, line) => {
    expect(hooked(line)).toBeNull();
  });
});
