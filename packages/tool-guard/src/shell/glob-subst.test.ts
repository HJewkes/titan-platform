import { describe, expect, it } from "vitest";
import { mayEnableGlobSubst } from "./glob-subst.js";
import { tokenize } from "./lexer.js";
import type { WordToken } from "./lexer.js";
import { unwrap } from "./unwrap.js";

function enables(src: string): boolean {
  const words = tokenize(src).filter((t): t is WordToken => t.type === "word");
  const cmd = unwrap(words);
  if (!cmd) throw new Error(`no command in ${src}`);
  return mayEnableGlobSubst(cmd);
}

describe("a command that may turn on zsh GLOB_SUBST", () => {
  it.each([
    ["setopt globsubst"],
    ["setopt Glob_Sub_st"],
    ["setopt -o globsubst"],
    ["setopt -oglobsubst"],
    ["setopt +o noglobsubst"],
    ["setopt -m '*subst'"],
    ["builtin setopt globsubst"],
    ["noglob setopt GLOB_SUBST"],
    ["setopt nonoglobsubst"],
    ["unsetopt noglobsubst"],
    ["unsetopt NO_GLOB_SUBST"],
    ["set -o globsubst"],
    ["set -o glob_subst"],
    ["set +o noglobsubst"],
    ["set -eo globsubst"],
    ["set -oglobsubst"],
    ["set -A options globsubst on"],
    ["options[globsubst]=on"],
    ["options+=(globsubst on)"],
    ["options[$k]=on"],
    ["read -A options <<< 'globsubst on'"],
    ["typeset options"],
    ["zparseopts -A options"],
    [": ${options[globsubst]::=on}"],
    ["emulate sh"],
    ["emulate ksh"],
    ["emulate -R ksh"],
    ["emulate zsh -o glob_subst"],
    ["emulate -L zsh -o globsubst"],
    ["emulate zsh -oglobsubst"],
    ["zsh -o GLOB_SUBST -c x"],
    ["zsh -oglobsubst -c x"],
    ["zsh --globsubst -c x"],
    ["zsh --glob-subst -c x"],
    ["zsh +o noglobsubst -c x"],
    ["zsh --emulate ksh -c x"],
    ["zsh --emulate=sh -c x"],
    ["$c globsubst"],
    ["$c options[globsubst]=on"],
  ])("reads %s as an enabler", (src) => {
    expect(enables(src)).toBe(true);
  });

  it.each([
    ["setopt $o"],
    ['setopt -o "$o"'],
    ["unsetopt $o"],
    ['set -o "$o"'],
    ["set $opts"],
    ["set -A $name x"],
    ["emulate $m"],
    ["emulate zsh -o $o"],
    ["zsh -o $o -c x"],
    ["zsh $opts -c x"],
  ])("reads the run-time operand of %s as a possible enabler", (src) => {
    expect(enables(src)).toBe(true);
  });

  it.each([
    ["setopt extendedglob nonomatch"],
    ["setopt -o pipefail"],
    ["unsetopt nomatch"],
    ["set -e"],
    ["set -o pipefail"],
    ["set -eo pipefail"],
    ["set -- a b"],
    ['set -- "$@"'],
    ["emulate"],
    ["emulate -L zsh"],
    ["emulate -R zsh"],
    ["emulate zsh -c 'echo hi'"],
    ["emulate -L zsh -c 'emulate sh'"],
    ["zsh -o pipefail -c x"],
    ["zsh -c 'echo globsubst'"],
    ["zsh script.zsh --globsubst"],
    ["bash -o globsubst -c x"],
    ["git commit -m globsubst"],
    ["git commit -m 'setopt globsubst'"],
    ["echo options"],
    ["echo '${options}'"],
    ["opts=1"],
    ["read line"],
    ["typeset -A opts"],
    ["git push origin HEAD:feat"],
  ])("leaves %s alone", (src) => {
    expect(enables(src)).toBe(false);
  });
});
