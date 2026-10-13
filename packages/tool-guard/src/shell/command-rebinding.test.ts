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
    ["an append in a declaration", "typeset commands+=(y /x)"],
    ["printf -v attached", "printf -vcommands x"],
    ["read after a prompt", "read -p prompt -A commands"],
    ["getopts", "getopts ab commands"],
    ["zparseopts", "zparseopts -A commands a"],
    ["a bash nameref", "declare -n r=BASH_CMDS"],
    ["a nameref with no target yet", "local -n r"],
    ["a typeset nameref in a cluster", "typeset -gn r=commands"],
    ["printf -v a dynamic name", 'printf -v "$n" /x'],
    ["read a dynamic name", 'read "$n"'],
    ["typeset a dynamic name", 'typeset "$n"=/x'],
    ["set -A a dynamic name", 'set -A "$n" y /x'],
    ["declare -A a dynamic name", 'declare -A "$n"'],
    ["a dynamic option word", "declare $F r=BASH_CMDS"],
    ["a name spliced from a substitution", "export BASH$(echo _CMDS)[y]=/x"],
    ["a name spliced from a variable", "export ${n}=x"],
    ["a bash indirect expansion", ": ${!n=/x}"],
    ["a zsh (P) expansion", ": ${(P)n::=/x}"],
    ["read after an attached prompt", "read -pinput 'BASH_CMDS[y]'"],
    ["read after a cluster ending in a value option", "read -rpt 'BASH_CMDS[y]'"],
    ["bash read -a", "read -a BASH_CMDS"],
    ["set -A after -o and its value", "set -o pipefail -A commands y /x"],
    ["set with -A attached", "set -Acommands y /x"],
    ["set +A", "set +A commands y /x"],
    ["set behind a dynamic option word", "set -$o commands y /x"],
    ["printf behind a dynamic word with room for -v", 'printf "$f" "commands[y]" /x'],
    ["printf behind an unquoted dynamic word", "printf $args"],
    ["declare -f with a dynamic word before a name", 'declare -f "$o" r=BASH_CMDS'],
    ["zsh read -t, which takes only an attached number", "read -t 'commands[y]'"],
    ["zsh read -p, a flag", "read -p 'commands[y]'"],
    ["zsh read -n, a flag", "read -n 'commands[y]'"],
    ["a read prompt that zsh reads as a dynamic name", 'read -r -p "$P" line'],
    ["zsh read name?prompt", "read 'commands?go'"],
    ["zsh set with a digit option", "set -1 -A commands y /x"],
    ["zsh set with a digit in the -A cluster", "set -1A commands y /x"],
    ["an option word no cluster reads", "typeset -% commands"],
    ["getln -A", "getln -A commands"],
    ["getln an element", "getln 'commands[y]'"],
    ["zstyle -a", "zstyle -a ctx style commands"],
    ["zstyle -s", "zstyle -s ctx style 'BASH_CMDS[y]'"],
    ["zstyle -g", "zstyle -g functions"],
    ["zformat -f", "zformat -f functions fmt"],
    ["vared -e, a flag", "vared -e 'commands[y]'"],
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
    ["a declared value naming a parameter", 'export PATH="$HOME/bin:$PATH"'],
    ["a read into an ordinary name", "read -r -p 'Name: ' line"],
    ["zstyle setting a style", "zstyle ':completion:*' menu select"],
    ["printf printing a parameter name", "printf '%s\\n' functions"],
    ["print printing a parameter name", "print commands"],
    ["set naming a parameter as a positional", "set -- commands"],
    ["export -n, which unexports", "export -n FOO"],
    ["an indirect read", "echo ${!n}"],
    ["a hash lookup after --", "hash -- -p"],
    ["set -o and its value", "set -o pipefail"],
    ["a dynamic printf format", 'printf "$fmt" "$x"'],
    ["declare -f printing a function", 'declare -f "$fn"'],
  ])("is left alone: %s", (_how, src) => {
    expect(rebinds(src)).toBe(false);
  });

  it("refuses through the reading limit, so no swallow site drops it", () => {
    const error = new CommandRebindingError();

    expect(error).toBeInstanceOf(ReadingLimitError);
    expect(error.message).toBe("a command that rebinds a command name");
  });
});
