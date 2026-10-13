import { describe, expect, it } from "vitest";
import { AliasDefinitionError, definesAlias } from "./alias-definitions.js";
import { caseNamed } from "./case-script.js";
import { normalizeDeclarations } from "./declarations.js";
import { tokenize } from "./lexer.js";
import type { WordToken } from "./lexer.js";
import { ReadingLimitError } from "./unsure-readings.js";

const defines = (src: string) => {
  const words = normalizeDeclarations(tokenize(src)).filter((t): t is WordToken => t.type === "word");
  const [cmd] = caseNamed(words);
  if (!cmd) throw new Error(`no command in ${src}`);
  return definesAlias(cmd);
};

describe("a command that defines a shell alias", () => {
  it.each([
    ["the alias builtin", "alias y=git"],
    ["a global alias", "alias -g P=x"],
    ["a suffix alias", "alias -s txt=echo"],
    ["an operand after --", "alias -- -='cd -'"],
    ["a definition after a query operand", "alias g y=git"],
    ["a dynamic operand", 'alias "$X"'],
    ["alias under builtin", "builtin alias y=git"],
    ["alias under command", "command alias y=git"],
    ["an escaped alias word", "\\alias y=git"],
    ["enable -a", "enable -a y"],
    ["enable with -a in a cluster", "enable -am 'y*'"],
    ["an element store into aliases", "aliases[y]=git"],
    ["an array store into aliases", "aliases=(y git)"],
    ["an append to galiases", "galiases+=(P x)"],
    ["a store into dis_aliases", "dis_aliases[y]=git"],
    ["typeset of aliases", "typeset -A aliases"],
    ["set -A aliases", "set -A aliases y git"],
    ["read -A saliases", "read -A saliases"],
    ["printf -v into an aliases element", "printf -v 'aliases[y]' git"],
    ["an assigning expansion of aliases", ": ${aliases[y]::=git}"],
    ["an assigning expansion as the command word", "${aliases[y]::=git}"],
    ["a dynamic command word with a definition operand", '"$C" y=git'],
    ["a dynamic command word with alias options first", '"$C" -g P=x'],
    ["a dynamic command word past a lone -", '"$C" - y=git'],
    ["a dynamic command word past --", '"$C" -- y=git'],
    ["a dynamic command word with an option word after the first operand", '"$C" g -x y=git'],
    ["alias past a lone -", "alias - y=git"],
    ["alias with an option word after the first operand", "alias g -x y=git"],
    ["printf -v with the name attached", "printf -valiases[y] git"],
    ["print -v in a cluster with the name attached", "print -rvaliases[y] git"],
    ["zparseopts -A with the name attached", "zparseopts -Aaliases a"],
    ["zstyle -s into aliases", "zstyle -s ':ctx' style aliases"],
    ["zformat -f into galiases", "zformat -f galiases '%a' a:x"],
    ["strftime -s into saliases", "strftime -s saliases '%Y' 0"],
    ["an indirect assigning expansion", ": ${(P)n::=git}"],
    ["a plain read of the alias table", ": $aliases"],
    ["an element store into BASH_ALIASES", "BASH_ALIASES[y]=git"],
    ["declare -A BASH_ALIASES", "declare -A BASH_ALIASES"],
    ["an assigning expansion of BASH_ALIASES", ": ${BASH_ALIASES[y]:=git}"],
    ["enable with a dynamic option word", 'enable "$O" y'],
    ["printf -v with a dynamic name", 'printf -v "$n" x'],
    ["printf -v with a dynamic name attached", "printf -v$n x"],
    ["print -v in a cluster with a dynamic name", 'print -rv "$n" x'],
    ["typeset with a dynamic name", 'typeset "$n"=git'],
    ["declare -A with a dynamic name", 'declare -A "$n"'],
    ["set -A with a dynamic name", 'set -A "$n" y git'],
    ["read -A with a dynamic name", 'read -A "$n"'],
    ["read with a dynamic name operand", 'read -r "$n"'],
    ["getopts with a dynamic name", 'getopts ab "$n"'],
    ["vared with a dynamic name", 'vared "$n"'],
    ["zparseopts -A with a dynamic name", 'zparseopts -A "$n" h'],
    ["a zparseopts spec storing into aliases", "zparseopts -D h=aliases"],
    ["zformat -f with a dynamic name", 'zformat -f "$n" x a:b'],
    ["strftime -s with a dynamic name", "strftime -s \"$n\" '%Y' 0"],
    ["zstyle -s with a dynamic name", "zstyle -s ':ctx' style \"$n\""],
    ["a nameref to BASH_ALIASES", "declare -n r=BASH_ALIASES"],
    ["a nameref to aliases", "typeset -n r=aliases"],
    ["a nameref to an aliases element", "local -n r=aliases[y]"],
    ["a nameref with a dynamic target", 'declare -n r="$t"'],
    ["a nameref bound later", "declare -n r"],
    ["read -t, which zsh reads as a flag before a name", 'read -t "$n"'],
    ["read -p, a flag in zsh and a prompt in bash", 'read -p "$n" x'],
    ["read -n, a flag in zsh", 'read -n "$n"'],
    ["read with -t in a cluster", 'read -rt "$n"'],
    ["getln into an aliases element", 'getln "aliases[y]"'],
    ["getln into a dynamic name", 'getln "$n"'],
    ["sysread into an aliases element", 'sysread "aliases[y]"'],
    ["sysread into a dynamic name", 'sysread "$n"'],
    ["sysread -c into a dynamic count name", 'sysread -c "$n" buf'],
  ])("is refused: %s", (_how, src) => {
    expect(defines(src)).toBe(true);
  });
});

describe("a command that only reads or removes aliases, or names them as text", () => {
  it.each([
    ["listing every alias", "alias"],
    ["querying one alias", "alias g"],
    ["listing as commands", "alias -L"],
    ["listing by pattern", "alias -m 'g*'"],
    ["removing one", "unalias g"],
    ["virtualenv's pydoc query", "alias pydoc"],
    ["enable without -a", "enable -f y"],
    ["searching for the word", "rg aliases packages/"],
    ["printing a definition as text", "echo alias y=git"],
    ["a quoted expansion as text", "echo '${aliases[y]::=git}'"],
    ["grepping for a subscript", "grep -r 'aliases\\[' src"],
    ["a git alias", "git config alias.co checkout"],
    ["a dynamic interpreter's -c text", '"$PY" -c x=1'],
    ["a dynamic compiler's define", '"$CC" -DFOO=1'],
    ["a leading environment assignment", "FOO=1 git status"],
    ["a similarly named variable", "my_aliases[y]=git"],
    ["a quoted alias-table name beside an expansion", "echo \"$x\"'$aliases'"],
    ["printf -v into another variable", "printf -vout git"],
    ["a non-indirect assigning expansion", ": ${n::=git}"],
    ["enable with a dynamic word after its first operand", 'enable -f y "$F"'],
    ["printf with a dynamic format", 'printf "$fmt" x'],
    ["printf -v into a static name with a dynamic format", 'printf -v out "$fmt" x'],
    ["print to a dynamic fd", 'print -u "$fd" x'],
    ["typeset with a dynamic value", 'typeset x="$v"'],
    ["export with a dynamic value", 'export PATH="$HOME/bin:$PATH"'],
    ["typeset with a dynamic subscript", 'typeset "x[$k]"=v'],
    ["read into a static name", "read -r line"],
    ["read with a static delimiter", "read -d '' line"],
    ["read with an attached timeout", "read -t5 line"],
    ["getln into a static name", "getln line"],
    ["sysread with a timeout into a static name", "sysread -t 5 buf"],
    ["typeset -f of a dynamic function name", 'typeset -f "$fn"'],
    ["declare -p of a dynamic name", 'declare -p "$n"'],
    ["getopts with a dynamic option string", 'getopts "$opts" opt'],
    ["set with dynamic positionals", 'set -- "$@"'],
    ["set -o with a dynamic option", 'set -o "$o"'],
    ["a nameref to another variable", "declare -n r=other"],
    ["export -n, which only unexports", "export -n FOO"],
    ["zstyle setting a dynamic style value", "zstyle ':ctx' style \"$v\""],
  ])("passes: %s", (_how, src) => {
    expect(defines(src)).toBe(false);
  });
});

describe("AliasDefinitionError", () => {
  it("is a reading limit, so every site that drops a reading rethrows it", () => {
    const error = new AliasDefinitionError();

    expect(error).toBeInstanceOf(ReadingLimitError);
    expect(error.name).toBe("AliasDefinitionError");
    expect(error.message).toBe("a command that defines a shell alias");
  });
});
