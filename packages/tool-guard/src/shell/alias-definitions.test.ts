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
