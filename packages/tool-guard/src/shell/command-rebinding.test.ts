import { describe, expect, it } from "vitest";
import { caseNamed } from "./case-script.js";
import { CommandRebindingError, rebindsCommand } from "./command-rebinding.js";
import { normalizeDeclarations } from "./declarations.js";
import type { WordToken } from "./lexer.js";
import { tokenize } from "./lexer.js";
import { ParseError } from "./parse-error.js";
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
    ["an append in a declaration", "typeset commands+=(y /x)"],
    ["printf -v attached", "printf -vcommands x"],
    ["read after a prompt", "read -p prompt -A commands"],
    ["getopts", "getopts ab commands"],
    ["zparseopts", "zparseopts -A commands a"],
    ["printf behind a dynamic word with room for -v", 'printf "$f" "commands[y]" /x'],
    ["printf behind an unquoted dynamic word", "printf $args"],
    ["print behind a word that may be -v", 'print "$f" commands[y] /x'],
    ["wait -p with a computed name before a pid", 'wait -p "$n" $!'],
    ["a keyed list", "declare -A BASH_CMDS=([y]=/x)"],
    ["a keyed list without -A", "declare BASH_CMDS=([y]=/x)"],
    ["a zsh keyed list", "typeset -A commands=([y]=/x)"],
    ["a keyed append in a list", "declare -A BASH_CMDS=([y]+=/x)"],
    ["a bash nameref", "declare -n r=BASH_CMDS"],
    ["a nameref with no target yet", "local -n r"],
    ["a typeset nameref in a cluster", "typeset -gn r=commands"],
    ["printf -v a dynamic name", 'printf -v "$n" /x'],
    ["set -A a dynamic name", 'set -A "$n" y /x'],
    ["a dynamic option word", "declare $F r=BASH_CMDS"],
    ["read after an attached prompt", "read -pinput 'BASH_CMDS[y]'"],
    ["read after a cluster ending in a value option", "read -rpt 'BASH_CMDS[y]'"],
    ["bash read -a", "read -a BASH_CMDS"],
    ["set -A after -o and its value", "set -o pipefail -A commands y /x"],
    ["set with -A attached", "set -Acommands y /x"],
    ["set +A", "set +A commands y /x"],
    ["set behind a dynamic option word", "set -$o commands y /x"],
    ["declare -f with a dynamic word before a name", 'declare -f "$o" r=BASH_CMDS'],
    ["zsh read -t, which takes only an attached number", "read -t 'commands[y]'"],
    ["zsh read -p, a flag", "read -p 'commands[y]'"],
    ["zsh read -n, a flag", "read -n 'commands[y]'"],
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
    ["zparseopts -A attached", "zparseopts -Acommands a"],
    ["zparseopts -a attached", "zparseopts -acommands a"],
    ["zparseopts -A attached after -E", "zparseopts -E -Acommands y:"],
    ["zparseopts -A with a dynamic name", 'zparseopts -A"$n" y:'],
    ["a zparseopts spec storing into a parameter", "zparseopts y:=commands"],
    ["functions -c", "functions -c f y"],
    ["zparseopts -A after a leading --", "zparseopts -- -A commands y:"],
    ["zparseopts -a after a leading --", "zparseopts -- -a commands y:"],
    ["zparseopts -E -A after a leading --", "zparseopts -- -E -A commands y:"],
    ["zstyle -a after a leading --", "zstyle -- -a :z k commands"],
    ["zstyle -s after a leading --", "zstyle -- -s :z k 'BASH_CMDS[y]'"],
    ["zstyle -g after a leading --", "zstyle -- -g functions"],
    ["zformat -f after a leading --", "zformat -- -f functions fmt"],
    ["getopts after --", "getopts -- ab commands"],
    ["strftime -s", "strftime -s 'commands[y]' 0"],
    ["zstat -A", "zstat -A commands f"],
    ["sysread", "sysread functions"],
    ["pcre_match -v", "pcre_match -v commands x"],
    ["zselect -a", "zselect -a commands"],
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
    ["declare -f printing a function", 'declare -f "$fn"'],
    ["printf printing only a dynamic word", 'printf "$msg"'],
    ["zparseopts into an ordinary name", "zparseopts -A opts -D y: v=verbose"],
    ["functions listing", "functions -x 2 f"],
    ["functions -c after --, which names functions", "functions -- -c f y"],
    ["a run-time value word", 'printf "$fmt" "$x"'],
    ["a run-time value word", 'print "$f" x'],
    ["a run-time value word", 'printf "$f" x'],
    ["a run-time value word", 'print "$f"'],
    ["a run-time value word", 'print -r "$f"'],
    ["a run-time value word", 'builtin print "$f"'],
    ["wait on a pid", "wait $!"],
    ["shift by arithmetic", "shift $((OPTIND-1))"],
    ["print a parameter read", "print -l $commands[git]"],
    ["declare -p of a rebinding parameter", "declare -p BASH_CMDS"],
    ["typeset -p of a rebinding parameter", "typeset -p commands"],
    ["a dynamic declarer name, which the guard allows today", "export $(cmd)"],
    ["a dynamic read word", 'read "$n"'],
    ["a dynamic typeset word", 'typeset "$n"=/x'],
    ["a dynamic declare -A word", 'declare -A "$n"'],
    ["a name spliced from a substitution", "export BASH$(echo _CMDS)[y]=/x"],
    ["a name spliced from a variable", "export ${n}=x"],
    ["a read prompt that expands", 'read -r -p "$P" line'],
    ["a dynamic export word", 'export "$V=d"'],
    ["a declare option the shell rejects", "declare -Q Y=status"],
    ["a nameref to an ordinary name", "declare -n Y=status"],
    ["a quoted expansion text", "echo '${(P)n::=x}'"],
    ["a gh word that expands to an option", 'gh pr edit 12 "--$X"'],
    ["a gh option word that varies", "gh --$F x pr merge"],
  ])("is left alone: %s", (_how, src) => {
    expect(rebinds(src)).toBe(false);
  });

  it("refuses through the reading limit, so no swallow site drops it", () => {
    const error = new CommandRebindingError();

    expect(error).toBeInstanceOf(ReadingLimitError);
    expect(error.message).toBe("a command that rebinds a command name");
  });
});

describe("an assigning expansion that would rebind a command name", () => {
  it.each([
    ["an ::= expansion", ": ${commands[y]::=/x}"],
    ["a := expansion", ": ${functions[y]:=x}"],
    ["a bash = expansion", ": ${BASH_CMDS[y]=/x}"],
    ["an expansion in a declared value", "local X=${commands[y]::=/x}"],
    ["a bash indirect expansion", ": ${!n=/x}"],
    ["a zsh (P) expansion", ": ${(P)n::=/x}"],
  ])("is refused before the matcher reads it: %s", (_how, src) => {
    expect(() => rebinds(src)).toThrow(ParseError);
  });
});
