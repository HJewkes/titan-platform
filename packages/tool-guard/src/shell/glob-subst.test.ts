import { describe, expect, it } from "vitest";
import { namesGlobSubstOption } from "./glob-subst.js";
import { tokenize } from "./lexer.js";
import type { WordToken } from "./lexer.js";
import { unwrap } from "./unwrap.js";

function names(src: string): boolean {
  const words = tokenize(src).filter((t): t is WordToken => t.type === "word");
  const cmd = unwrap(words);
  if (!cmd) throw new Error(`no command in ${src}`);
  return namesGlobSubstOption(cmd);
}

describe("a command that may name zsh GLOB_SUBST", () => {
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
    ["setopt -- globsubst"],
    ["emulate rksh"],
    ["unsetopt -- noglobsubst"],
    ["emulate -- sh"],
    ["setopt -m -- 'glob*'"],
  ])("reads %s as naming the option", (src) => {
    expect(names(src)).toBe(true);
  });

  it.each([
    ["setopt $o"],
    ['setopt -o "$o"'],
    ["unsetopt $o"],
    ['set -o "$o"'],
    ["set $opts"],
    ["emulate $m"],
    ["emulate zsh -o $o"],
    ["zsh -o $o -c x"],
    ["zsh $opts -c x"],
    ["setopt glob{subst,}"],
    ["setopt {glob,}subst"],
    ["setopt globsub?t"],
    ["setopt glob*"],
    ["setopt glob'*'"],
    ["unsetopt -- noglob*"],
    ["set -o glob*"],
    ["emulate {s,}h"],
    ["setopt globsubs^x"],
    ["setopt globsubst#"],
    ["setopt globsubst~x"],
    ["setopt ~g"],
    ["setopt ~1"],
    ["setopt ~-0"],
    ["setopt ~+1"],
    ["$c $o"],
    ['$c -o "$o"'],
    ['$c "$n"'],
    ["$c sh"],
    ["$c -R ksh"],
    ["$c -m '*subst'"],
    ["s{etopt,} globsubst"],
    ["set{opt,opt} globsubst"],
    ["{emulate,emulate} sh"],
    ["/bin/zs[h] -o globsubst -c x"],
    ["builtin s{etopt,} globsubst"],
    ["b{uiltin,} setopt globsubst"],
    ["~g/setopt globsubst"],
    ["$c rksh"],
    ["$c rsh"],
    ["$c bourne"],
    ["$c ksh93"],
    ["{emulate,emulate} -R cfoo"],
    ["ARGV0=sh zsh -c 'ls $x'"],
    ["ARGV0=$a zsh -c x"],
    ["exec -a ksh zsh -c 'ls $x'"],
    ["exec -cla -ksh zsh -c x"],
    ["exec -a /bin/rksh zsh -c x"],
    ["exec -a $a zsh -c x"],
    ["env --argv0 sh zsh -c 'ls $x'"],
    ["env --argv0=bourne zsh -c x"],
    ["env -a csh zsh -c x"],
    ["/bin/zs[h] --emulate sh -c 'ls $x'"],
    ["$c --emulate=ksh -c 'ls $x'"],
    ["{zsh,zsh} --emulate sh -c x"],
    ["ARGV0=sh $c -c 'ls $x'"],
    ["exec -a sh /bin/zs[h] -c x"],
    ["env -a ksh {zsh,zsh} -c x"],
    ['$c x="$y"'],
  ])("reads the run-time or expanded operand of %s as a possible name", (src) => {
    expect(names(src)).toBe(true);
  });

  it.each([
    ["setopt extendedglob nonomatch"],
    ["echo options"],
    ["setopt nonomatch extendedglob"],
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
    ["setopt 'glob*'"],
    ["setopt -- extendedglob"],
    ["emulate -- zsh"],
    ["set -- *.txt"],
    ["zsh ~/x.zsh"],
    ["zsh ~"],
    ["$c foo bar"],
    ["$c -o pipefail"],
    ["{echo,echo} hi there"],
    ["$c foo"],
    ["$c rzsh"],
    ["~/bin/tool hi"],
    ['[ -n "$x" ]'],
    ['[ -f "$f" ]'],
    ["[[ -f $f ]]"],
    ["[[ $a == b* ]]"],
    ["ARGV0=zsh zsh -c x"],
    ["exec -a myzsh zsh -c x"],
    ["exec -a sh git status"],
    ["env --argv0 foo zsh -c x"],
    ["emulate foo"],
    ["ARGV0=sh git status"],
  ])("leaves %s alone", (src) => {
    expect(names(src)).toBe(false);
  });
});

describe("argv0 of a wrapped command", () => {
  function argv0(src: string): Array<string | null> | undefined {
    const words = tokenize(src).filter((t): t is WordToken => t.type === "word");
    return unwrap(words)?.argv0;
  }

  it.each([
    ["exec -a ksh zsh -c x", ["ksh"]],
    ["exec -aksh zsh -c x", ["ksh"]],
    ["exec -cla -ksh zsh -c x", ["-ksh"]],
    ["env --argv0 sh zsh -c x", ["sh"]],
    ["env --argv0=sh zsh -c x", ["sh"]],
    ["env -a sh zsh -c x", ["sh"]],
    ["env -u FOO -a sh zsh -c x", ["sh"]],
    ["ARGV0=sh zsh -c x", ["sh"]],
    ["exec -a $a zsh -c x", [null]],
  ])("reads %s", (src, expected) => {
    expect(argv0(src)).toEqual(expected);
  });

  it.each([["env -uabc zsh -c x"], ["env -u a zsh -c x"], ["env -Sabc zsh -c x"], ["env -C a zsh -c x"], ["exec zsh -c x"], ["git status"]])(
    "finds none in %s",
    (src) => {
      expect(argv0(src)).toBeUndefined();
    },
  );
});
