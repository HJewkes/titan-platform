import { describe, expect, it } from "vitest";
import { writesHookedParam } from "./hooked-params.js";
import { tokenize } from "./lexer.js";
import type { WordToken } from "./lexer.js";
import { unwrap } from "./unwrap.js";

const hooked = (line: string) => {
  const cmd = unwrap(tokenize(line).filter((t): t is WordToken => t.type === "word"));
  return cmd && writesHookedParam(cmd);
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
  ])("returns null: %s", (_how, line) => {
    expect(hooked(line)).toBeNull();
  });
});
