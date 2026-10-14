import { describe, expect, it } from "vitest";
import { ifsChanged, namesIfs, splittingWords } from "./ifs.js";
import { tokenize } from "./lexer.js";
import type { WordToken } from "./lexer.js";
import type { Vars } from "./vars.js";

const words = (src: string) => tokenize(src).filter((t): t is WordToken => t.type === "word");
const splitting = (src: string) => [...splittingWords(words(src))];
const singleQuoted = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const nestedEvals = (line: string, levels: number): string =>
  levels === 0 ? line : nestedEvals(`eval ${singleQuoted(line)}`, levels - 1);

describe("splittingWords", () => {
  it("marks an unquoted variable expansion", () => {
    expect(splitting("gh api $E")).toEqual([2]);
  });

  it("skips a double-quoted expansion, whole or after a literal", () => {
    expect(splitting('gh api "$E"')).toEqual([]);
    expect(splitting('gh api a"$E"')).toEqual([]);
  });

  it("marks an expansion outside quotes even when part of the word is quoted", () => {
    expect(splitting('gh api "a"$E')).toEqual([2]);
  });

  it("skips the leading assignment run but not a later NAME= argument", () => {
    expect(splitting("X=$E Y=$F gh api $E")).toEqual([4]);
    expect(splitting("export X=$E")).toEqual([1]);
  });

  it("skips computed words, which already read as run time", () => {
    expect(splitting("echo $((1+2)) $(cat f)")).toEqual([]);
  });

  it("skips a computed word even when it carries refs", () => {
    const [, word] = words("echo ${E%x}");
    expect(word?.computed).toBe(true);
    expect(splitting("echo ${E%x}")).toEqual([]);
  });

  it("skips literal words", () => {
    expect(splitting("git push origin main")).toEqual([]);
  });
});

describe("ifsChanged", () => {
  const vars = (entries: Array<[string, string | null]>): Vars => new Map(entries);

  it("is true for a custom separator", () => {
    expect(ifsChanged(vars([["IFS", ","]]))).toBe(true);
  });

  it("is true for a write the walk could not read", () => {
    expect(ifsChanged(vars([["IFS", null]]))).toBe(true);
  });

  it("is true for an empty IFS, which turns splitting off but is still not the default", () => {
    expect(ifsChanged(vars([["IFS", ""]]))).toBe(true);
  });

  it("is false when IFS was never written or holds the default", () => {
    expect(ifsChanged(vars([]))).toBe(false);
    expect(ifsChanged(vars([["IFS", " \t\n"]]))).toBe(false);
  });
});

describe("namesIfs", () => {
  it("matches IFS anywhere in the text", () => {
    expect(namesIfs("while IFS= read -r l; do :; done")).toBe(true);
    expect(namesIfs('declare "OLDIFS=$IFS"')).toBe(true);
  });

  it.each([
    ["an escaped letter", "declare I\\FS=,"],
    ["an empty quote pair", "read I''FS"],
    ["a quoted letter", 'export "I"FS=,'],
    ["a line continuation", "IF\\\nS=,"],
    ["an ANSI-C escape", "declare $'\\x49FS=,'"],
    ["printf -v with an escape", "printf -v I\\FS %s ,"],
    ["a brace list", "read {I,}FS"],
    ["a brace range", "read {H..J}FS"],
    ["an eval text that unquotes to IFS", "eval 'I\\FS=,'"],
    ["a command substitution", "x=$(read I\\FS)"],
  ])("matches IFS spelled with %s", (_form, line) => {
    expect(namesIfs(line)).toBe(true);
  });

  it("does not match a line without IFS", () => {
    expect(namesIfs("git push origin x")).toBe(false);
    expect(namesIfs("echo {I,J}{F,G} 'I'F")).toBe(false);
  });

  it.each([
    ["an escaped closing brace", "declare {I,\\}}FS=,"],
    ["an escaped opening brace", "declare {I,\\{}FS=,"],
    ["a double-quoted brace", 'declare {I,"}"}FS=,'],
    ["a single-quoted brace", "declare {I,'{'}FS=,"],
  ])("matches a brace list with %s as an item", (_form, line) => {
    expect(namesIfs(line)).toBe(true);
  });

  it.each([4, 7, 8, 12])("matches an escaped IFS under %i nested evals", (levels) => {
    expect(namesIfs(nestedEvals("declare I\\FS=,", levels))).toBe(true);
  });

  it("fails closed fast on a brace list whose expansion would be huge", () => {
    const items = Array.from({ length: 250 }, (_, i) => `a${i}`).join(",");
    const started = performance.now();

    const named = namesIfs(`echo {${items}}{\u0001..￿}`);

    expect(named).toBe(true);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it.each([
    ["names joined from variables", "c=S; b=F; a=I; declare $a$b$c=,"],
    ["a case-changing expansion", "x=ifs; declare ${x^^}=,"],
    ["a command substitution as the name", "declare \"$(printf '\\x49FS')\"=,"],
    ["a substitution inside the name", "declare I$(echo F)S=,"],
    ["a function body before the write", "R=origin,HEAD:main; f(){ git push $R; }; c=S; b=F; a=I; declare $a$b$c=,; f"],
    ["a run-time read option word", "read $opt line"],
    ["eval of run-time text", 'eval "$a$b$c=,"'],
    ["let of run-time text", "let $n=1"],
    ["arithmetic of run-time text", "(( $n = 1 ))"],
    ["a run-time command word", "$c $a$b$c=,"],
    ["builtin before the writer", "builtin declare $a=,"],
    ["a declare nameref to a run-time target", "declare -n R=$a$b; R=,"],
    ["a local nameref to a run-time target", "f(){ local -n R=$a$b; R=,; }"],
    ["a typeset nameref to a run-time target", "typeset -n R=$a$b; R=,"],
    ["a bare nameref bound later", "declare -n R; R=$a$b; R=,"],
    ["wait -p", "wait -p $a$b"],
    ["compgen -V", "compgen -V $a$b w"],
    ["zsh print -v", "print -v $a$b ,"],
    ["zsh set -A", "set -A $a$b ,"],
    ["zsh vared", "vared $a$b"],
    ["zsh zparseopts", "zparseopts a=$a$b"],
    ["zsh private", "private $a$b=,"],
    ["zsh sysread", "sysread $a$b"],
    ["zsh strftime -s", "strftime -s $a$b %s 0"],
    ["an option word the table cannot read", "declare -Q $a"],
  ])("matches a write whose name is built at run time: %s", (_form, line) => {
    expect(namesIfs(line)).toBe(true);
  });

  it.each([
    ["read ?", "read -r ?FS <<< ,"],
    ["read [ ]", "read [I]FS <<< ,"],
    ["read *", "read *FS <<< ,"],
    ["read -a", "read -a ?FS <<< ,"],
    ["printf -v", "printf -v ?FS %s ,"],
    ["unset", "unset ?FS"],
    ["mapfile", "mapfile -t *FS < list"],
    ["getopts", "getopts ab ?FS"],
    ["declare", "declare ?FS=,"],
    ["read -a with the name attached", "read -a?FS <<< ,"],
    ["read -ra with the name attached", "read -ra?FS <<< ,"],
    ["printf -v with the name attached", "printf -v?FS %s ,"],
  ])("matches a glob in the name slot of %s", (_form, line) => {
    expect(namesIfs(line)).toBe(true);
  });

  it.each([
    ["a globbed read", "rea? ?FS <<< ,"],
    ["a bracketed declare", "de[c]lare $a$b=,"],
    ["a braced read", "{rea,}d ?FS <<< ,"],
  ])("matches a command word that globs into a writer: %s", (_form, line) => {
    expect(namesIfs(line)).toBe(true);
  });

  it.each([
    ["a braced source", "{source,} ./f"],
    ["a braced dot", "{.,} ./f"],
    ["a braced declare -n", "{declare,} -n R=$a$b; R=,"],
    ["a variable naming source", "c=source; $c ./f"],
    ["a variable naming declare -n", "c=declare; $c -n R=$a$b; R=,"],
    ["builtin of a variable", "builtin $c"],
    ["command of a variable", "command $c"],
    ["a command substitution", "$(echo source) ./f"],
  ])("matches a command word that is not a static literal: %s", (_form, line) => {
    expect(namesIfs(line)).toBe(true);
  });

  it.each([
    ["declare -i with a run-time value", "declare -i x=$a$b"],
    ["declare -i, then a run-time value", "declare -i x; x=$a$b"],
    ["declare -i, then read", "declare -i x; read x < f"],
    ["local -ri", "f(){ local -ri x; read x; }"],
    ["typeset +i", "typeset +i x"],
    ["zsh integer", "integer x; read x < f"],
    ["zsh float", "float x; read x < f"],
    ["trap with run-time code", 'trap "$x" DEBUG'],
    ["mapfile -C", 'mapfile -C "$x" -c 1 arr < f'],
    ["readarray -tC", "readarray -tC cb arr < f"],
    ["a literal trap action", "trap 'declare $a$b=,' DEBUG"],
    ["an alias value", "alias d='declare $a$b=,'"],
    ["eval joining its arguments", "eval declare '$a$b=,'"],
    ["an escaped IFS in a trap action", "trap -- 'I\\FS=,' EXIT"],
  ])("matches an evaluator sink: %s", (_form, line) => {
    expect(namesIfs(line)).toBe(true);
  });

  it.each([
    "echo [[ ; read $n",
    "echo [[ ; declare $a=1",
    'echo [[ ; source "$f"',
    'echo [[ ; . "$f"',
    "ls [[ ; let $v",
    "echo [[ ; typeset -n r=$t",
    "echo [[ ; mapfile -C $c a",
    "grep -F [[ f && read $n",
    "case $a in [[) read $n;; esac",
    "command [[ ; read $n ; echo ]]",
    "builtin [[ ; read $n",
    "y=1 [[ ; read $n",
    "- [[ ; read $n",
    "nocorrect [[ ; read $n",
    "noglob [[ ; read $n",
    "command [[ -n y || read $n",
  ])("matches a write after a [[ that is an argument, not a conditional: %s", (line) => {
    expect(namesIfs(line)).toBe(true);
  });

  it.each([
    "[ -f x ] && echo $x",
    "trap 'rm -f $tmp' EXIT",
    "mapfile -t arr < f",
    "declare -r X=1",
    "echo {1..10}",
    "[[ -t 1 ]] && echo tty",
    "[ -t 0 ]",
    "test -t 2",
    "[[ -n y && -t 1 ]]",
    "[ 1 -eq 1 ]",
    "[[ $x == -t ]]",
    "bash -c 'git push origin $R'",
    "bash -e -c 'cd $dir'",
    "PATH=/x bash -c 'cd $dir'",
    ": ${x:=default} ${y:-$z}",
    "echo $HOME_ENV_DIR",
  ])("does not match a static command with no sink: %s", (line) => {
    expect(namesIfs(line)).toBe(false);
  });

  describe("inside a script the walk runs", () => {
    const loop = (write: string) => `R=origin,HEAD:main; for i in 1 2; do git push $R; ${write}; done`;
    const WRAPPERS: Array<[string, (script: string) => string]> = [
      ["bash -c", (s) => `bash -c ${singleQuoted(s)}`],
      ["sh -c", (s) => `sh -c ${singleQuoted(s)}`],
      ["a bash heredoc", (s) => `bash <<'EOF'\n${s}\nEOF`],
      ["echo piped into bash", (s) => `echo ${singleQuoted(s)} | bash`],
      ["a bash here-string", (s) => `bash <<< ${singleQuoted(s)}`],
      ["sudo bash -c", (s) => `sudo bash -c ${singleQuoted(s)}`],
      ["xargs sh -c fed a pipe", (s) => `printf '%s' ${singleQuoted(s)} | xargs -0 sh -c`],
      ["find -exec bash -c", (s) => `find . -exec bash -c ${singleQuoted(s)} \\;`],
      ["find -execdir sh -c", (s) => `find -execdir sh -c ${singleQuoted(s)} {} +`],
      ["bash -c of a printed string", (s) => `bash -c "$(printf %s ${singleQuoted(s)})"`],
    ];
    const WRITES = ["declare I\\FS=,", "declare $a$b=,", "$c source", "declare -i x; read x"];
    const rows = WRAPPERS.flatMap(([wrapper, wrap]) => WRITES.map((write) => [wrapper, write, wrap(loop(write))] as const));

    it.each(rows)("matches %s running %s", (_wrapper, _write, line) => {
      expect(namesIfs(line)).toBe(true);
    });

    it.each([
      ["bash -c of a variable", 'bash -c "$x"'],
      ["sh -c of a command substitution", "sh -c \"$(cat script)\""],
    ])("matches a run-time -c string, as for eval: %s", (_form, line) => {
      expect(namesIfs(line)).toBe(true);
    });

    it.each(WRAPPERS.filter(([wrapper]) => !wrapper.includes("printed")).map(([wrapper, wrap]) => [wrapper, wrap("git push origin $R; cd $dir")] as const))(
      "does not match %s running clean commands",
      (_wrapper, line) => {
        expect(namesIfs(line)).toBe(false);
      },
    );
  });

  it.each([
    ["zsh typeset -F", "typeset -F x; read x < f"],
    ["zsh typeset -E", "typeset -E x; read x < f"],
    ["a quoted subscript in unset", "unset 'a[$a$b=1]'"],
    ["an indirect expansion", "echo ${!x}"],
    ["a zsh (P) assignment", "a=I; b=FS; x=$a$b; : ${(P)x::=,}"],
    ["a zsh (P) default assignment", ": ${(P)x:=,}"],
    ["a zsh (e) evaluation", "echo ${(e)x}"],
    ["a zsh flag group after a prefix", "echo ${=(P)x}"],
    ["an indirect default assignment", ": ${!x:=,}"],
  ])("matches %s", (_form, line) => {
    expect(namesIfs(line)).toBe(true);
  });

  it.each([
    ["arithmetic expansion", ": $(( $a$b=1 ))"],
    ["a substring offset", "echo ${x:$a$b=1}"],
    ["an indexed subscript", "arr[$a$b=1]=x"],
    ["a [[ ]] arithmetic test", "[[ 1 -eq $a$b ]]"],
    ["a redirect target's arithmetic", ": >/dev/null$(( $a$b=1 ))"],
    ["a dup target's arithmetic", ": >&$(( $a$b=1 ))"],
    ["a here-string's arithmetic", ": <<< $(( $a$b=1 ))"],
    ["a heredoc body's arithmetic expansion", "a=IF; v=${a}S=1; : <<E\n$(( $v ))\nE"],
    ["a heredoc body's $[ ]", "a=IF; v=${a}S=1; : <<E\n$[ $v ]\nE"],
    ["a heredoc body's subscript", "a=IF; v=${a}S=1; arr=(ab); : <<E\n${arr[$v]}\nE"],
    ["a heredoc body's substring offset", "a=IF; v=${a}S=1; s=abc; : <<E\n${s:$v}\nE"],
    ["a heredoc body's indirect expansion", "arr=(ab); v=$(cat f); : <<E\n${!v}\nE"],
    ["a tab-stripped heredoc body", "a=IF; v=${a}S=1; : <<-E\n\t$(( $v ))\n\tE"],
    ["a heredoc body in a function", "a=IF; v=${a}S=1; f() { : <<E\n$(( $v ))\nE\n}; f"],
    ["source", "source ./env.sh"],
    ["dot", ". ./env.sh"],
    ["BASH_ENV before bash -c", "BASH_ENV=./f bash -c 'R=origin,HEAD:main; git push $R'"],
    ["ENV before sh -c", "ENV=./f sh -c 'git push origin $R'"],
    ["ZDOTDIR before zsh -c", "ZDOTDIR=/tmp/z zsh -c 'git push origin $R'"],
    ["HOME before zsh -c", "HOME=./d zsh -c 'git push origin $R'"],
    ["HOME before a zsh login shell", "HOME=./d zsh -o login -c 'git push origin $R'"],
    ["an earlier HOME export", "export HOME=./d; zsh -c 'git push origin $R'"],
    ["HOME before bash --login", "HOME=./d bash --login -c 'git push origin $R'"],
    ["a brace-built BASH_ENV export", "export {BASH_,}ENV=./f; bash -c 'git push origin $R'"],
    ["a brace-suffixed BASH_ENV export", "export BASH_EN{V,}=./f; bash -c 'git push origin $R'"],
    ["BASH_ENV through env","env BASH_ENV=./f bash -c 'git push origin $R'"],
    ["an earlier BASH_ENV export", "export BASH_ENV=./f; bash -c 'git push origin $R'"],
    ["a BASH_ENV export before a nested shell", "export BASH_ENV=./f; x=$(bash -c 'git push origin $R')"],
    ["bash --rcfile -i", "bash --rcfile ./f -i -c 'git push origin $R'"],
    ["bash --init-file", "bash --init-file ./f -c 'git push origin $R'"],
    ["an interactive cluster", "bash -ic 'git push origin $R'"],
    ["a login shell", "bash -l -c 'git push origin $R'"],
    ["bash --login", "bash --login -c 'git push origin $R'"],
  ])("matches run-time arithmetic or a sourced file: %s", (_form, line) => {
    expect(namesIfs(line)).toBe(true);
  });

  it.each([
    "read -r line",
    "read -r -p 'Name: ' n",
    "declare -n R=target; R=x",
    "i=0; echo $((i + 1)) ${x:-$y} ${s:2}",
    "[[ $x == y ]]",
    "cd $dir",
    "cd .. && ls ./src",
    'export PATH="$HOME/bin:$PATH"',
    "HOME=./d git push origin $R",
    "cp {a,b}.txt ./d; bash -c 'git push origin main'",
    "declare X=$(date) Y=${z^^}",
    "for f in *.txt; do echo $f; done",
    "printf '%s\\n' $x",
    "git push origin $R",
    "cd $dir && ls *.ts",
    "mapfile -t lines < <(ls $d)",
    "unset -f my-func",
    ": <<'E'\n$(( $v ))\nE",
    ': <<"E"\n${arr[$v]}\nE',
    ": <<\\E\n$(( $v ))\nE",
    ": <<-'E'\n\t${s:$v}\n\tE",
    "git commit -F - <<EOF\nfix: push $(git rev-parse --short HEAD) to ${R:-origin}\nEOF\ngit push origin $R",
  ])("does not match a write whose name is literal: %s", (line) => {
    expect(namesIfs(line)).toBe(false);
  });

  describe("arithmetic that reads a value the line writes", () => {
    const push = (line: string) => `a=IF; x=$a"S=1"; ${line}; R=origin1HEAD:main; git push $R`;

    it.each([
      ["let", "let x"],
      ["an arithmetic command", "(( x ))"],
      ["a compound arithmetic assignment", "((x+=0))"],
      ["an arithmetic expansion", ": $((x))"],
      ["a [[ ]] arithmetic test", "[[ x -eq 0 ]]"],
      ["zsh [[ -t ]]", "[[ -t x ]]"],
      ["zsh [ -t ]", "[ -t x ]"],
      ["zsh test -t", "test -t x"],
      ["zsh [[ ! -t ]]", "[[ ! -t x ]]"],
      ["zsh -t after && inside [[ ]]", "[[ -n y && -t x ]]"],
      ["zsh -t after || inside [[ ]]", "[[ -z y || -t x ]]"],
      ["zsh -t in a [[ ]] group", "[[ ( -t x ) ]]"],
      ["zsh [ ] arithmetic test", "[ x -eq 0 ]"],
      ["zsh test arithmetic", "test 0 -lt x"],
      ["an arithmetic test after && inside [[ ]]", "[[ -n y && x -ne 0 ]]"],
      ["zsh [[ -t ]] on an arithmetic expression", "[[ -t x+0 ]]"],
      ["-t after && in [[ ]] under if", "if [[ -n y && -t x ]]; then :; fi"],
      ["-t after && in [[ ]] under !", "! [[ -n y && -t x ]]"],
      ["-t after && in [[ ]] in a group", "{ [[ -n y && -t x ]]; }"],
      ["-t after && in [[ ]] under while", "while [[ -n y && -t x ]]; do :; done"],
      ["-t after && in [[ ]] under until", "until [[ -n y && -t x ]]; do :; done"],
      ["-t after && in [[ ]] under time -p --", "time -p -- [[ -n y && -t x ]]"],
      ["-t after && in [[ ]] under coproc", "coproc [[ -n y && -t x ]]"],
      ["-t after && in [[ ]] in a function body", "f(){ [[ -n y && -t x ]]; }"],
      ["-t after && in [[ ]] in a subshell", "( [[ -n y && -t x ]] )"],
      ["-t in a [[ ]] after command", "command [[ -t x ]]"],
      ["-t in a [[ ]] after noglob", "noglob [[ -t x ]]"],
      ["-t in a [[ ]] after an assignment", "y=1 [[ -t x ]]"],
      ["a substring offset", "s=abc; : ${s:x}"],
      ["an indexed subscript", "arr[x]=1"],
      ["a name whose literal value names another", "y=x; : $((y))"],
      ["zsh shift", "shift x"],
      ["zsh printf %d", "printf %d x"],
      ["an unquoted heredoc body", "cat <<EOF\n$((x))\nEOF"],
    ])("matches %s", (_form, line) => {
      expect(namesIfs(push(line))).toBe(true);
    });

    it.each([
      ["a default assignment", "a=IF; : ${x:=${a}S=1}; let x"],
      ["a plain default assignment", "a=IF; : ${x=${a}S=1}; let x"],
      ["a zsh unconditional assignment", "a=IF; : ${x::=${a}S=1}; let x"],
      ["a default assignment over a number", "x=0; a=IF; : ${x:=${a}S=1}; let x"],
      ["read into REPLY", "a=IF; read <<< ${a}S=1; let REPLY"],
      ["read into REPLY set to a number", "REPLY=0; a=IF; read <<< ${a}S=1; let REPLY"],
      ["getopts into OPTARG", "a=IF; getopts a: o -a ${a}S=1; let OPTARG"],
      ["the last argument in _", "a=IF; : ${a}S=1; let _"],
      ["the last argument in _ under (( ))", "a=IF; : ${a}S=1; (( _ ))"],
      ["BASH_REMATCH", "a=IF; [[ ${a}S=1 =~ .* ]]; let BASH_REMATCH"],
      ["MAPFILE", "a=IF; mapfile <<< ${a}S=1; let MAPFILE"],
      ["zsh MATCH", "a=IF; [[ ${a}S=1 =~ .* ]]; let MATCH"],
      ["zsh reply", "reply=0; a=IF; read -A <<< ${a}S=1; let reply"],
      ["a name the line never writes", "let x"],
      ["a loop bound the lexer reads as a redirect", "for ((i = 0; i < n; i++)); do :; done"],
      ["read from a file", "read x < f; let x; git push $R"],
      ["read inside eval", "eval 'read x' < f; let x; git push $R"],
      ["a loop over run-time words", "for x in $(cat f); do let x; done"],
    ])("matches a value given by %s", (_form, line) => {
      expect(namesIfs(`${line}; R=origin1HEAD:main; git push origin $R`)).toBe(true);
    });

    it.each([
      ["a redirect target's arithmetic expansion", "a=IF; x=${a}S=1; : >/dev/null$(( x ))"],
      ["a redirect target's subscript", "a=IF; x=${a}S=1; : >/dev/null${arr[x]}"],
      ["a dup target's arithmetic expansion", "a=IF; x=${a}S=1; echo hi >&$((x))"],
      ["a here-string's arithmetic expansion", "a=IF; x=${a}S=1; : <<< $(( x ))"],
      ["a here-string's subscript", "a=IF; x=${a}S=1; : <<< ${arr[x]}"],
      ["a default assignment in a redirect target", "x=1; unset x; a=IF; : >/dev/null${x:=${a}S=1}; let x"],
      ["a default assignment in an unquoted heredoc", "x=1; unset x; a=IF; : <<EOF\n${x:=${a}S=1}\nEOF\nlet x"],
      ["[ -v ] on a subscript", "a=IF; x=${a}S=1; [ -v 'arr[x]' ]"],
      ["test -v on a subscript", "a=IF; x=${a}S=1; test -v 'arr[x]'"],
      ["[ -v ] on a run-time name", "v=$(cat f); [ -v \"$v\" ]"],
      ["zsh print -f", "a=IF; x=${a}S=1; print -f '%d' x"],
      ["zsh print -f in a cluster", "a=IF; x=${a}S=1; print -rf '%d' x"],
      ["a * width", "a=IF; x=${a}S=1; printf '%*s' x y"],
      ["a positional conversion", "a=IF; x=${a}S=1; printf '%1$d' x"],
      ["a format after --", "a=IF; x=${a}S=1; printf -- '%d' x"],
      ["a format that opens with - after --", "a=IF; x=${a}S=1; printf -- '-%d' x"],
      ["zsh's unbraced subscript", "a=IF; x=${a}S=1; arr=(a b); : $arr[x]"],
      ["zsh's unbraced length subscript", "a=IF; x=${a}S=1; arr=(ab); : $#arr[x]"],
      ["zsh's unbraced length subscript in double quotes", 'a=IF; x=${a}S=1; arr=(ab); : "$#arr[x]"'],
      ["zsh's unbraced length subscript in a redirect target", "a=IF; x=${a}S=1; arr=(ab); : >/dev/null$#arr[x]"],
      ["zsh's $+ subscript", "a=IF; x=${a}S=1; arr=(ab); : $+arr[x]"],
      ["zsh's $^ subscript", "a=IF; x=${a}S=1; arr=(ab); : $^arr[x]"],
      ["zsh's $= subscript", "a=IF; x=${a}S=1; arr=(ab); : $=arr[x]"],
      ["zsh's $~ subscript", "a=IF; x=${a}S=1; arr=(ab); : $~arr[x]"],
      ["zsh's ${+ } subscript", "a=IF; x=${a}S=1; arr=(ab); : ${+arr[x]}"],
      ["zsh's ${^ } subscript", "a=IF; x=${a}S=1; arr=(ab); : ${^arr[x]}"],
      ["zsh's ${= } subscript", "a=IF; x=${a}S=1; arr=(ab); : ${=arr[x]}"],
      ["a chained subscript", "a=IF; x=${a}S=1; arr=(ab); : ${arr[1][x]}"],
      ["an unbraced chained subscript", "a=IF; x=${a}S=1; arr=(ab cd); : $arr[1][x]"],
      ["zsh's $@ subscript", "a=IF; x=${a}S=1; set -- ab; : $@[x]"],
      ["a subscript after a nested expansion", "a=IF; x=${a}S=1; arr=(ab cd); : ${${arr[1]}[x]}"],
      ["a length subscript after a nested expansion", "a=IF; x=${a}S=1; arr=(ab cd); : ${#${arr}[x]}"],
      ["a length subscript", "a=IF; x=${a}S=1; arr=(ab); : ${#arr[x]}"],
      ["a subscript before a default", "a=IF; x=${a}S=1; arr=(ab); : ${arr[x]:-d}"],
      ["a subscript inside a default", "a=IF; x=${a}S=1; arr=(ab); : ${y:-${arr[x]}}"],
      ["zsh's ${=x:=} assignment", "x=1; unset x; a=IF; : ${=x:=${a}S=1}; let x"],
      ["zsh's ${^x:=} assignment", "x=1; unset x; a=IF; : ${^x:=${a}S=1}; let x"],
      ["zsh's ${~x:=} assignment", "x=1; unset x; a=IF; : ${~x:=${a}S=1}; let x"],
      ["a write through a nameref", "a=IF; x=1; declare -n r=x; r=${a}S=1; let x"],
    ])("matches arithmetic outside the command words: %s", (_form, line) => {
      expect(namesIfs(`${line}; R=origin1HEAD:main; git push origin $R`)).toBe(true);
    });

    it.each([
      "i=0; while (( i < 3 )); do i=$((i+1)); done; git push origin $R",
      "for i in 1 2 {3..5}; do echo $((i*2)); done; git push origin $R",
      "n=2; s=abc; echo ${s:1} ${s:n}; git push origin $R",
      "i=4; arr[0]=a; arr[1]=b; echo ${arr[1]} $((i + 1)); git push origin $R",
      "local x; let x=1; git push origin $R",
      "i=0; (( i++ )); git push origin $R",
      "for ((i = 0; i < 3; i++)); do git push origin $R; done",
      "printf '%s\\n' a b; git push origin \"${R:-origin}\" $((1 + 2))",
      "git commit -m 'arr[i] and $((x))' && ulimit -n 1024 && git push origin $R",
      "cat <<'EOF'\n$((x))\nEOF\ngit push origin $R",
      "i=0; n=3; (( i<n )); git push origin $R",
      "i=0; n=3; while [[ i -lt n ]]; do git push origin $R && break; i=$((i+1)); done",
      "printf '%s %b %q\\n' x y z; print -f '%s' x; git push origin $R",
      'git push origin $R >"$LOG" 2>&1',
      'git push origin $R > "${LOG:-/dev/null}"',
      "git push origin ${BRANCH}:main $R:refs/heads/x",
      'git push origin "${R:-${DEFAULT_BRANCH}}" "$1" "${@:2}"',
      "i=0; arr=(a b); git push origin ${arr[i]}",
    ])("does not match arithmetic over numbers the line writes: %s", (line) => {
      expect(namesIfs(line)).toBe(false);
    });
  });

  it.each([
    ["zsh noglob", "noglob typeset $a$b$c=,"],
    ["zsh nocorrect", "nocorrect typeset $a$b$c=,"],
    ["zsh -", "- typeset $a$b$c=,"],
    ["exec", "exec typeset $a$b$c=,"],
    ["a function keyword body", "function f { declare $a$b=,; }; f"],
    ["zsh's ksh93 nameref", "zmodload zsh/ksh93; nameref r=$a$b; r=,"],
    ["zsh sysopen -u", "sysopen -u $a$b -r f"],
    ["zsh compadd -A", "compadd -A $a$b x"],
    ["an autoloaded function", "autoload f; f; git push origin $R"],
    ["zsh emulate -c", "emulate zsh -c $x"],
  ])("matches a write behind a precommand modifier or a builtin the model does not read: %s", (_form, line) => {
    expect(namesIfs(line)).toBe(true);
  });

  it.each([
    "git push origin main",
    "noglob git push origin $R",
    "exec 3>&1; git push origin $R",
    "cd $dir && echo $R && git push origin $R",
    "function f { git push origin $R; }; f",
  ])("does not match a modeled or external command: %s", (line) => {
    expect(namesIfs(line)).toBe(false);
  });

  it("reads 64KB under 8 nested evals in under 200 ms", () => {
    const line = nestedEvals(`echo ${"$a ".repeat(21_000)}; declare $a$b$c=,`, 8);
    const started = performance.now();

    const named = namesIfs(line);

    expect(line.length).toBeGreaterThan(64 * 1024);
    expect(named).toBe(true);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("does not match a numeric range", () => {
    expect(namesIfs("for i in {1..10}; do echo $i; done")).toBe(false);
  });

  it("matches a line that fails to parse once it holds I, F and S in order", () => {
    expect(namesIfs("echo 'I")).toBe(false);
    expect(namesIfs("I\\FS=, echo 'x")).toBe(true);
  });
});
