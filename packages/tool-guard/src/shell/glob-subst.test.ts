import { spawnSync } from "node:child_process";
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
    ["=zsh -o globsubst -c x"],
    ["zsh5 -o globsubst -c x"],
    ["/bin/zsh5 --emulate sh -c x"],
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
    ["$c -a -sh zsh -c x"],
    ["$c -a /bin/sh zsh -c x"],
    ["ex{ec,ec} -a -sh zsh -c x"],
    ["/usr/bin/en[v] --argv0 /bin/sh zsh -c x"],
    ["/usr/bin/en[v] --argv /bin/sh zsh -c x"],
    ["$c --argv0=sh zsh -c x"],
    ["env -a sh -S 'zsh -c x'"],
    ["env -S '-a sh zsh -c x'"],
    ["env -S '--argv0=sh zsh -c x'"],
    ["env -S '--argv0 sh zsh -c x'"],
    ["env -S '-ash zsh -c x'"],
    ["env -S 'A=1 -a sh zsh -c x'"],
    ["env --split-string='-a sh zsh -c x'"],
    ["env --split-string '-a sh zsh -c x'"],
    ["env -vS '-a sh zsh -c x'"],
    ["env -vS'-a sh zsh -c x'"],
    ["rzsh -o globsubst -c x"],
    ["rzsh --emulate sh -c x"],
    ["ARGV0=sh $c -c 'ls $x'"],
    ["exec -a sh /bin/zs[h] -c x"],
    ["env -a ksh {zsh,zsh} -c x"],
    ['$c x="$y"'],
    ['"$c" globsubst'],
    ['"$c" rksh'],
    ['"$c" "$o"'],
    ["exec -a =sh zsh -c x"],
    ["env -S '-a \"sh\" zsh -c x'"],
    ["ARGV0==sh zsh -c x"],
  ])("reads the run-time or expanded operand of %s as a possible name", (src) => {
    expect(names(src)).toBe(true);
  });

  it.each([
    ["''{setopt,globsubst}"],
    ['""{setopt,globsubst}'],
    ["{setopt,globsubst}"],
    ["builtin {setopt,globsubst}"],
    ["''{emulate,sh}"],
    ["''{set,-o,globsubst}"],
    ["''{zsh,-o,globsubst} -c x"],
    ["''{zsh,--emulate,sh} -c x"],
    ["''{exec,-a,sh,zsh} -c x"],
    ["exec ''{-a,sh} zsh -c x"],
    ["env ''{-a,sh} zsh -c x"],
    ["exec -a ''{sh,zsh} -c x"],
    ["exec -a $a git status"],
    ["[es]*"],
    ["''{e,s}*"],
    ["~g globsubst"],
    ["$(echo setopt globsubst)"],
    ["`echo setopt globsubst`"],
    ["$a"],
    ['"$x[@]"'],
    ["$=c"],
    ["setopt $=o"],
    ["{echo,echo} hi there"],
    ["$c foo bar"],
    ["$c -o pipefail"],
    ["$c foo"],
    ["$c rzsh"],
    ["$c -a zsh zsh -c x"],
    ["$EDITOR f"],
    ['"${(f)c}" x'],
    ['"${a[@]}" x'],
    ['"$@"'],
  ])("reads %s, whose command word or argv0 may expand to more words, as naming the option", (src) => {
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
    ["~/bin/tool hi"],
    ['[ -n "$x" ]'],
    ['[ -f "$f" ]'],
    ["[[ -f $f ]]"],
    ["[[ $a == b* ]]"],
    ["ARGV0=zsh zsh -c x"],
    ["rzsh -o pipefail -c x"],
    ["env -a zsh -S 'zsh -c x'"],
    ["env -S '-a zsh zsh -c x'"],
    ["env -S '-u abc zsh -c x'"],
    ["exec -a myzsh zsh -c x"],
    ["exec -a sh git status"],
    ["env --argv0 foo zsh -c x"],
    ["emulate foo"],
    ["ARGV0=sh git status"],
    ['"$EDITOR" f'],
    ['"$HOME/bin/tool"'],
    ['"$CC" -c x.c'],
  ])("leaves %s alone", (src) => {
    expect(names(src)).toBe(false);
  });
});

const zsh = spawnSync("zsh", ["-c", "exit 0"]).status === 0;

/** Whether `$x` holding a glob qualifier ran its code after `prefix`, under the zsh on this machine. */
function qualifierRan(prefix: string): boolean {
  const inner = 'setopt nonomatch; x="*(e:RAN=1:)"; : $x; print -r -- ${RAN-no}';
  const out = spawnSync("zsh", ["-c", `${prefix} "$INNER"`], { encoding: "utf8", env: { ...process.env, INNER: inner } });
  return out.stdout.trim() === "1";
}

describe.skipIf(!zsh)("real zsh against the reader", () => {
  it.each([["=zsh -o globsubst -c"], ["zsh5 -o globsubst -c"]])("runs the qualifier after %s, which the reader names", (prefix) => {
    const stubbed = prefix.startsWith("zsh5") ? prefix.replace("zsh5", "zsh") : prefix;
    expect(qualifierRan(stubbed)).toBe(true);
    expect(names(`${prefix} x`)).toBe(true);
  });

  it("does not run the qualifier after a quoted command word whose arguments are setopt globsubst", () => {
    const out = spawnSync("zsh", ["-c", 'x=echo; "$x" setopt globsubst >/dev/null; y="*(e:RAN=1:)"; : $y; print -r -- ${RAN-no}'], { encoding: "utf8" });
    expect(out.stdout.trim()).toBe("no");
  });
});
