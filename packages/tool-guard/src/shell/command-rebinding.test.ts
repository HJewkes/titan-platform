import { describe, expect, it } from "vitest";
import { caseNamed } from "./case-script.js";
import { CommandRebindingError, rebindsCommand } from "./command-rebinding.js";
import { normalizeDeclarations } from "./declarations.js";
import type { WordToken } from "./lexer.js";
import { tokenize } from "./lexer.js";
import { ReadingLimitError } from "./unsure-readings.js";

const rebinds = (src: string) => {
  const words = normalizeDeclarations(tokenize(src)).filter((t): t is WordToken => t.type === "word");
  const [cmd] = caseNamed(words);
  if (!cmd) throw new Error(`no command in ${src}`);
  return rebindsCommand(cmd);
};

describe("a command that rebinds a command name", () => {
  it.each([
    ["zsh hash", "hash y=/usr/bin/git"],
    ["several bindings", "hash a=/x b=/y"],
    ["a named directory", "hash -d r=/repo"],
    ["a binding after --", "hash -- y=/x"],
    ["bash hash -p", "hash -p /usr/bin/git y"],
    ["-p in a cluster", "hash -dp /x y"],
    ["a dynamic operand", 'hash "$X"'],
    ["a binding to a dynamic path", "hash y=$P"],
    ["behind builtin", "builtin hash y=/x"],
    ["behind command", "command hash -p /x y"],
    ["a backslashed hash", "\\hash y=/x"],
    ["behind a prefix assignment", "X=1 hash y=/x"],
    ["a commands element", "commands[y]=/x"],
    ["an append to commands", "commands+=(y /x)"],
    ["a BASH_CMDS element", "BASH_CMDS[y]=/x"],
    ["a functions element", "functions[y]='git push'"],
    ["a dis_functions element", "dis_functions[y]=x"],
    ["a nameddirs element", "nameddirs[r]=/repo"],
    ["set -A", "set -A commands y /x"],
    ["typeset -A", "typeset -A commands"],
    ["a typeset element", "typeset commands[y]=/x"],
    ["export", "export functions=x"],
    ["printf -v", "printf -v 'commands[y]' /x"],
    ["read -A", "read -A commands"],
    ["an ::= expansion", ": ${commands[y]::=/x}"],
    ["a := expansion", ": ${functions[y]:=x}"],
    ["a bash = expansion", ": ${BASH_CMDS[y]=/x}"],
    ["an expansion in a declared value", "local X=${commands[y]::=/x}"],
  ])("is caught: %s", (_how, src) => {
    expect(rebinds(src)).toBe(true);
  });

  it.each([
    ["listing", "hash"],
    ["a lookup", "hash git"],
    ["several lookups", "hash whoami id uname hostname"],
    ["a reset", "hash -r"],
    ["a listing option", "hash -L"],
    ["rehash", "rehash"],
    ["unhash", "unhash y"],
    ["unsetting an element", "unset 'commands[y]'"],
    ["a $+ test", ": $+commands[git]"],
    ["an element read", "echo ${commands[git]}"],
    ["a key listing", "echo ${(k)commands}"],
    ["a parameter word under another command", "rg commands src"],
    ["hash as an echoed word", "echo hash y=git"],
    ["a git alias", "git config alias.y push"],
    ["a prefix assignment", "FOO=1 git status"],
    ["a declaration of another name", "typeset -A mycommands"],
  ])("is left alone: %s", (_how, src) => {
    expect(rebinds(src)).toBe(false);
  });

  it("refuses through the reading limit, so no swallow site drops it", () => {
    const error = new CommandRebindingError();

    expect(error).toBeInstanceOf(ReadingLimitError);
    expect(error.message).toBe("a command that rebinds a command name");
  });
});
