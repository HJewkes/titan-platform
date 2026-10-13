import { describe, expect, it } from "vitest";
import { arithmeticHooked } from "./arith-hooked.js";
import { writesHookedParam } from "./hooked-params.js";
import { tokenize } from "./lexer.js";
import type { RedirectToken, WordToken } from "./lexer.js";
import { unwrap } from "./unwrap.js";

const hooked = (line: string) => {
  const tokens = tokenize(line);
  const words = tokens.filter((t): t is WordToken => t.type === "word");
  const cmd = unwrap(words);
  return cmd && writesHookedParam(cmd, words, tokens.filter((t): t is RedirectToken => t.type === "redirect"));
};

describe("a command that writes a parameter the shell later runs", () => {
  it.each([
    ["a bare assignment", "PS4='$(x)'", "PS4"],
    ["a prefix assignment", "PS4=x bash -xc true", "PS4"],
    ["an env assignment", "env PS4=x bash -xc true", "PS4"],
    ["an append", "PS4+=x", "PS4"],
    ["export", "export PS4='$(x)'", "PS4"],
    ["an export append", "export PS4+=x", "PS4"],
    ["export after builtin", "builtin export PS4=x", "PS4"],
    ["zsh typeset of PROMPT4", "typeset -g PROMPT4=x", "PROMPT4"],
    ["a nameref to PS4", "declare -n R=PS4", "PS4"],
    ["a nameref to an element", "declare -n R=PS4[0]", "PS4"],
    ["zsh typeset -T of the tied pair", "typeset -T MODULE_PATH module_path", "MODULE_PATH"],
    ["a quoted declared name", "export 'PS4'=x", "PS4"],
    ["read", "read -r PS4", "PS4"],
    ["read of an element", "read PS4[0]", "PS4"],
    ["zsh read -A", "read -A module_path", "module_path"],
    ["a zsh read prompt", "read 'PS4?Name: '", "PS4"],
    ["a for loop variable", "for PS4 in a", "PS4"],
    ["getopts", "getopts o PS4", "PS4"],
    ["mapfile", "mapfile module_path", "module_path"],
    ["printf -v", "printf -v PS4 x", "PS4"],
    ["printf -v attached", "printf -vPS4 x", "PS4"],
    ["printf -v of an element", "printf -v PS4[0] x", "PS4"],
    ["printf -v of an element, attached", "printf -vPS4[0] x", "PS4"],
    ["zsh print -v", "print -v PS4 x", "PS4"],
    ["zsh print -v in a cluster", "print -rv PS4 x", "PS4"],
    ["zsh print -v of an element", "print -v PS4[1] x", "PS4"],
    ["zsh set -A", "set -A module_path /tmp/m", "module_path"],
    ["zsh set +A", "set +A module_path /tmp/m", "module_path"],
    ["zsh vared", "vared PS4", "PS4"],
    ["zsh zstyle -s", "zstyle -s c s PS4", "PS4"],
    ["zsh strftime -s", "strftime -s PS4 %s 0", "PS4"],
    ["a zsh array assignment", "module_path=(/tmp/m $module_path)", "module_path"],
    ["a zsh array append", "module_path+=(/tmp/m)", "module_path"],
    ["an element assignment", "module_path[1]=/tmp/m", "module_path"],
    ["the scalar tie", "MODULE_PATH=/tmp/m", "MODULE_PATH"],
    ["read -a attached", "read -aPS4", "PS4"],
    ["read -a attached in a cluster", "read -raPS4", "PS4"],
    ["zsh strftime -s attached", "strftime -sPS4 %s 0", "PS4"],
    ["zsh zstat -A attached", "zstat -APS4 f", "PS4"],
    ["zsh/stat's stat builtin", "stat -A module_path +name /m", "module_path"],
    ["stat -A after zsh's -t flag", "stat -t -A module_path +name /m", "module_path"],
    ["stat -A in a cluster after zsh's -t flag", "stat -tA module_path +name /m", "module_path"],
    ["stat -A after zsh's -F, a BSD flag", "stat -F -A module_path +name /m", "module_path"],
    ["stat -A after GNU's -f flag", "stat -f -A module_path +name /m", "module_path"],
    ["read -a after zsh's -p flag", "read -p -aPS4", "PS4"],
    ["zsh zparseopts -A attached", "zparseopts -APS4 a", "PS4"],
    ["a zparseopts spec's array", "zparseopts -D h=PS4", "PS4"],
    ["zsh print -v after -f's value", "print -f %s -v PS4 x", "PS4"],
    ["zsh print -v after -u's value", "print -u 2 -v PS4 x", "PS4"],
    ["zsh print -v after -C's value", "print -C 2 -v PS4 x", "PS4"],
    ["zsh zformat -f", "zformat -f PS4 '%a' a:x", "PS4"],
    ["zsh zformat -a", "zformat -a module_path : a:x", "module_path"],
    ["zsh pcre_match -v", "pcre_match -v PS4 x", "PS4"],
    ["bash compgen -V", "compgen -V PS4 -W x", "PS4"],
    ["bash wait -p", "wait -p PS4", "PS4"],
    ["zsh zselect -A", "zselect -A module_path 0", "module_path"],
    ["zsh for over two names", "for X PS4 in a b", "PS4"],
    ["zsh read -t's next word as a name", "read -t PS4", "PS4"],
    ["a default-assign expansion", ": ${PS4:=x}", "PS4"],
    ["a plain default-assign expansion", ": ${PS4=x}", "PS4"],
    ["a zsh array default-assign expansion", ": ${(A)module_path::=/tmp/m}", "module_path"],
    ["a default-assign in another assignment's value", "X=${PS4:=x}", "PS4"],
    ["a default-assign in a prefix assignment's value", "X=${PS4:=x} true", "PS4"],
    ["a default-assign of an element", ": ${PS4[0]:='$(x)'}", "PS4"],
    ["a plain default-assign of an element", ": ${PS4[0]=x}", "PS4"],
  ])("names it: %s", (_how, line, name) => {
    expect(hooked(line)).toBe(name);
  });
});

describe("a name slot the shell computes", () => {
  it.each([
    ["an indirect prefix expansion", "read ${!PS@}", "${!PS@}"],
    ["a quoted indirect prefix expansion", 'read "${!PS@}"', "${!PS@}"],
    ["the keys of an array", 'read "${!m[@]}"', "${!m[@]}"],
    ["an arithmetic expansion", "read PS$((4))", "PS$((4))"],
    ["an arithmetic sum", "read PS$((2+2))", "PS$((2+2))"],
    ["a variable", 'read "$N"', "$N"],
    ["a variable before the =", 'export "$N"=x', "$N=x"],
    ["a command substitution before the =", "export $(echo PS4)=x", "=x"],
    ["a dynamic printf option", 'printf "$O" x', "$O"],
    ["a dynamic set option", "set $O", "$O"],
    ["a dynamic printf -v operand", 'printf -v "$N" x', "$N"],
    ["a nameref to an arithmetic name", "declare -n r=PS$((4))", "r=PS$((4))"],
    ["a nameref to an indirect expansion", "declare -n r=${!PS@}", "r=${!PS@}"],
    ["a bare nameref a later assignment binds", "declare -n r", "r"],
    ["a bare nameref in a cluster", "local -rn r", "r"],
    ["an unknown option on a name-writing command", "read -Q x", "-Q"],
    ["an unknown printf option", "printf -x x", "-x"],
    ["a dynamic option word", "read -$O x", "-$O"],
    ["a brace list", "export {P,}S4=x", "{P,}S4=x"],
    ["a brace list in read", "read {P,}S4", "{P,}S4"],
    ["an escaped closing brace", "export {P,\\}}S4=x", "{P,}}S4=x"],
    ["a double-quoted closing brace", 'export {P,"}"}S4=x', "{P,}}S4=x"],
    ["a single-quoted closing brace", "export {P,'}'}S4=x", "{P,}}S4=x"],
    ["an escaped opening brace", "read {P,\\{}S4", "{P,{}S4"],
    ["an escaped opening brace first", "read {\\{,P}S4", "{{,P}S4"],
    ["an integer range", "read PS{1..9}", "PS{1..9}"],
    ["a zsh braceccl character range", "typeset {O-Q}S4=x", "{O-Q}S4=x"],
    ["a brace list that spells no hooked name", "read {a,b}", "{a,b}"],
    ["a ? glob", "read P?4", "P?4"],
    ["a * glob", "read P*4", "P*4"],
    ["a bracket expression", "read P[S]4", "P[S]4"],
    ["a subscript that globs to a hooked name", "read PS[4]", "PS[4]"],
    ["a POSIX character class", "read [[:upper:]]S4", "[[:upper:]]S4"],
    ["a POSIX equivalence class", "read [[=P=]]S4", "[[=P=]]S4"],
    ["a POSIX collating symbol", "read [[.P.]]S4", "[[.P.]]S4"],
    ["a glob in export", "export P?4=x", "P?4=x"],
    ["a glob that supplies the =", "export P?4?*", "P?4?*"],
    ["a glob that supplies the = in declare", "declare P?4?x", "P?4?x"],
    ["a glob that supplies a subscript", "read PS4?0?", "PS4?0?"],
    ["a glob in printf -v", "printf -v P?4 x", "P?4"],
    ["a glob attached to printf -v", "printf -vP?4 x", "P?4"],
    ["a partly quoted glob", "read P'S'?", "PS?"],
    ["a zsh ^ under extendedglob", "typeset ^X=x", "^X=x"],
    ["a zsh # under extendedglob", "read P#S4", "P#S4"],
    ["a zsh ~ under extendedglob", "read PS4~x", "PS4~x"],
  ])("counts as a hooked write: %s", (_how, line, slot) => {
    expect(hooked(line)).toBe(slot);
  });

  it("reads a 100 KB line of brace words without expanding them", () => {
    const words = tokenize(`read ${"{1..1000} ".repeat(10_000)}`).filter((t): t is WordToken => t.type === "word");
    const cmd = unwrap(words);
    const started = performance.now();

    const named = cmd && writesHookedParam(cmd, words);

    expect(named).toBe("{1..1000}");
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("a command that only reads, mentions or writes another name", () => {
  it.each([
    ["echo of PS4", "echo $PS4"],
    ["echo of braced PS4", "echo \"${PS4}\""],
    ["PS4 as another assignment's value", "X=$PS4 env"],
    ["a search", "rg PS4 src"],
    ["a grep for module_path", "grep module_path f"],
    ["a commit message", "git commit -m 'refuse PS4 writes'"],
    ["a quoted default-assign in a commit message", "git commit -m 'set ${PS4:=x}'"],
    ["unset", "unset PS4"],
    ["set -x", "set -x"],
    ["set with options and an operand", "set -euo pipefail"],
    ["set -- with a glob", "set -- *"],
    ["a stock zsh module", "zmodload zsh/datetime"],
    ["a longer name", "export PS5=x"],
    ["a nameref to a longer name", "declare -n R=PS44"],
    ["a default-assign of another name", ": ${X:=PS4}"],
    ["a value that expands", "export PATH=~/bin:$PATH"],
    ["a value that globs", "export X=*"],
    ["a value holding #", "local x=a#b"],
    ["read of an element", "read arr[0]"],
    ["read with a literal prompt", "read -r -p 'Name? ' ans"],
    ["a fully quoted glob", "read 'P?4'"],
    ["printf operands that expand", "printf '%s\\n' {1..5} *.ts \"${a#b}\""],
    ["printf -v of another name", "printf -v out '%s' *"],
    ["mapfile with a count", "mapfile -n 5 lines"],
    ["getopts over the arguments", 'getopts "ab:" opt "$@"'],
    ["a nameref to a literal name", "declare -n r=x"],
    ["export -n, which unexports", "export -n x"],
    ["a zsh typeset width", "typeset -L10 x"],
    ["a zsh typeset base as the next word", "typeset -i 16 x"],
    ["zselect with a timeout", "zselect -t 10"],
    ["GNU stat with a format", "stat -c %s f"],
    ["GNU stat with a long option", "stat --format=%s -L f"],
    ["BSD stat with a time format", "stat -f %m -t %s f"],
    ["BSD stat with an attached time format", "stat -t%Y f"],
    ["zsh print with values", "print -u 2 -C 2 a b"],
    ["read with a timeout", "read -t 5 x"],
    ["compgen of words", "compgen -W 'a b' a"],
    ["a C-style for", "for ((i = 0; i < 3; i++)); do :; done"],
    ["for over one name", "for x in PS4"],
    ["a glob in a command that writes no named parameter", "ls P?4"],
    ["a brace word in a command that writes no named parameter", "echo {P,}S4"],
  ])("returns null: %s", (_how, line) => {
    expect(hooked(line)).toBeNull();
  });
});

describe("an option word the walk reads both ways", () => {
  it("reads a long run of either-letters in linear time", () => {
    const words = tokenize(`stat ${"-t ".repeat(20_000)}-A module_path`).filter((t): t is WordToken => t.type === "word");
    const cmd = unwrap(words);
    const started = performance.now();

    const named = cmd && writesHookedParam(cmd, words);

    expect(named).toBe("module_path");
    expect(performance.now() - started).toBeLessThan(200);
  });

  it.each([
    ["read, whose -p ends options in zsh", "read", "-p a "],
    ["stat, whose -t ends options in BSD stat", "stat", "-t a "],
  ])("slots the operands once when many readings end options: %s", (_how, name, unit) => {
    const words = tokenize(`${name} ${unit.repeat(20_000)}-A module_path`).filter((t): t is WordToken => t.type === "word");
    const cmd = unwrap(words);
    const started = performance.now();

    const named = cmd && writesHookedParam(cmd, words);

    expect(named).toBe("module_path");
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("fails closed on an option word too long to walk", () => {
    expect(hooked(`stat -${"t".repeat(300)} f`)).toBe(`-${"t".repeat(300)}`);
  });
});

describe("an assign-on-expand through a name the shell resolves", () => {
  it.each([
    ["bash ${!N:=…}, as in N=PS4; unset PS4; : ${!N:=hooked}", ": ${!N:=hooked}"],
    ["zsh ${(P)N::=…}, as in N=PS4; : ${(P)N::=hooked}", ": ${(P)N::=hooked}"],
    ["bash ${!N=…}", ": ${!N=hooked}"],
    ["zsh ${(P)N:=…}", ": ${(P)N:=hooked}"],
    ["zsh ${(P)N=…}", ": ${(P)N=hooked}"],
    ["zsh flags around P", ": ${(Pk)N::=hooked}"],
    ["zsh flags with P last", ": ${(AP)N::=hooked}"],
    ["zsh P over a nested name", ": ${(P)${N}::=hooked}"],
    ["an indirect element", ": ${!N[0]:=hooked}"],
    ["an indirect element whose subscript expands", ": ${!N[$i]:=hooked}"],
    ["a hooked element whose subscript expands", ": ${PS4[$i]:=hooked}"],
    ["inside another word", "echo x${!N:=hooked}y"],
    ["in an assignment's value", "X=${(P)N::=hooked}"],
    ["in a double-quoted word", 'echo "${!N:=hooked}"'],
    ["a $ inside a zsh flag argument", ": ${(s:$:)PS4::=x}"],
    ["P after a flag argument holding $", ": ${(s:$:P)N::=x}"],
    ["a ) as a flag delimiter", ": ${(s.).)PS4::=x}"],
    ["P after a ) delimiter", ": ${(s.).P)N::=x}"],
    ["a bracket-paired flag delimiter", ": ${(s[)])PS4::=x}"],
    ["l with three arguments", ": ${(l:5::P::x:)PS4::=x}"],
    ["zsh = splitting", ": ${=PS4::=x}"],
    ["zsh ~ globbing", ": ${~PS4::=x}"],
    ["zsh ^ rc-expansion", ": ${^PS4::=x}"],
    ["zsh doubled ==", ": ${==PS4::=x}"],
    ["zsh = after the P flag", ": ${(P)=N::=x}"],
    ["zsh = after the A flag", ": ${(A)=module_path::=/m}"],
    ["zsh # length prefix", ": ${#PS4::=x}"],
    ["zsh # length prefix on PROMPT4", ": ${#PROMPT4::=x}"],
    ["zsh + set-test prefix", ": ${+module_path::=x}"],
    ["zsh = and # prefixes", ": ${=#PS4::=x}"],
    ["zsh # after the P flag", ": ${(P)#N::=x}"],
    ["zsh + after the P flag", ": ${(P)+N::=x}"],
    ["# with :=, a bad substitution in bash that zsh assigns", ": ${#PS4:=x}"],
    ["+ with :=, a bad substitution in bash that zsh assigns", ": ${+PS4:=x}"],
  ])("counts as a hooked write: %s", (_how, line) => {
    expect(hooked(line)).not.toBeNull();
  });

  it.each([
    ["bash ${!N:-…}, which only substitutes", ": ${!N:-x}"],
    ["zsh ${(P)N:-…}, which only substitutes", ": ${(P)N:-x}"],
    ["bash ${!N}", "echo ${!N}"],
    ["bash name-prefix expansion", "echo ${!PS@}"],
    ["bash array keys", 'echo "${!m[@]}"'],
    ["zsh flags without P", ": ${(k)N::=x}"],
    ["a P only inside a flag argument", ": ${(s.P.)N::=x}"],
    ["a non-indirect flag group that substitutes", ": ${(s:$:)PS4:-x}"],
    ["zsh # length of PS4", "echo ${#PS4}"],
    ["zsh + set-test of PS4", "echo ${+PS4}"],
    ["a quoted indirect assign in a commit message", "git commit -m 'set ${!N:=x}'"],
  ])("returns null: %s", (_how, line) => {
    expect(hooked(line)).toBeNull();
  });
});

describe("a zsh flag group too long to read", () => {
  it("fails closed as an indirect name", () => {
    const value = `\${(${"k".repeat(300)})N::=x}`;
    const word: WordToken = { type: "word", value, dynamic: true, quoted: false, spliced: false, computed: true, refs: [], subs: [] };

    expect(writesHookedParam({ name: ":", path: ":", args: [word], assigned: [] }, [word])).toBe(value);
  });
});

describe("reading assign-on-expand in a long word", () => {
  it.each([
    ["nested zsh flag openers", "${(".repeat(33_000)],
    ["a zsh flag group that never closes", `\${(${"P".repeat(100_000)}`],
    ["hooked subscripts that never close", "${PS4[".repeat(16_000)],
    ["indirect subscripts that never close", "${!a[".repeat(20_000)],
    ["P-flag subscripts that never close", "${(P)a[".repeat(14_000)],
    ["many flag-argument delimiters that never close", `\${(${"s:a:".repeat(30_000)}`],
    ["many readable flag groups", "${(s:$:)x}".repeat(10_000)],
    ["many l flags with three arguments", "${(l:1::a::b:".repeat(8_000)],
  ])("reads it in linear time: %s", (_how, value) => {
    const word: WordToken = { type: "word", value, dynamic: true, quoted: false, spliced: false, computed: true, refs: [], subs: [] };
    const started = performance.now();

    writesHookedParam({ name: ":", path: ":", args: [word], assigned: [] }, [word]);

    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("arithmetic that mentions a hooked parameter", () => {
  it.each([
    ["let", "let PS4=1", "PS4"],
    ["let of module_path, quoted", 'let "MODULE_PATH=7"', "MODULE_PATH"],
    ["$(( ))", ": $(( module_path = 3 ))", "module_path"],
    ["zsh $[ ]", ": $[ PS4 = 2 ]", "PS4"],
    ["a subscript inside ${ }", ": ${a[MODULE_PATH=4]}", "MODULE_PATH"],
    ["a bash subscript inside ${ }", ": ${a[PS4=5]}", "PS4"],
    ["a length of an element", ": ${#a[PS4=1]}", "PS4"],
    ["a zsh subscript after $name", ": $x[MODULE_PATH=1]", "MODULE_PATH"],
    ["a bash substring offset", ": ${x:PS4=0}", "PS4"],
    ["a substring length", ": ${x:0:PS4=1}", "PS4"],
    ["an assignment word's subscript", "a[PS4=7]=x", "PS4"],
    ["a prefix assignment's subscript", "a[PS4=7]=x true", "PS4"],
    ["read into a quoted subscripted name", "read 'a[PS4=6]'", "PS4"],
    ["printf -v into a subscripted name", "printf -v 'a[PS4=1]' x", "PS4"],
    ["a numeric [[ test", "[[ PS4=1 -eq 1 ]]", "PS4"],
    ["a declare -i value", "declare -i x=PS4=2", "PS4"],
    ["a zsh integer value", "integer x=PS4=3", "PS4"],
    ["a zsh float value", "float x=module_path=1", "module_path"],
    ["zsh printf %d", "printf %d MODULE_PATH=1", "MODULE_PATH"],
    ["zsh print -f %d", "print -f %d PS4=9", "PS4"],
    ["zsh repeat's count", "repeat 'MODULE_PATH=2' true", "MODULE_PATH"],
    ["zsh shift's count", "shift 'MODULE_PATH=1'", "MODULE_PATH"],
    ["zsh return's status", "return 'MODULE_PATH=3'", "MODULE_PATH"],
    ["zsh exit's status", "exit 'PS4=1'", "PS4"],
    ["zsh break's count", "break 'PS4=7'", "PS4"],
    ["zsh continue's count", "continue 'PS4=8'", "PS4"],
    ["zsh l flag width", ": ${(l:MODULE_PATH=4:)x}", "MODULE_PATH"],
    ["zsh r flag width", ": ${(r:MODULE_PATH=5:)x}", "MODULE_PATH"],
    ["zsh I flag index", ": ${(I:PS4=12:)x#a}", "PS4"],
    ["a value (( x )) evaluates later", "x='MODULE_PATH=6'", "MODULE_PATH"],
    ["a double-quoted value evaluated later", 'x="PS4=21"', "PS4"],
    ["a value with an increment", "x='PS4++'", "PS4"],
    ["a value with a pre-increment", "x='++PS4'", "PS4"],
    ["a value with a compound operator", "x='MODULE_PATH+=1'", "MODULE_PATH"],
    ["a value writing an element", "x='PS4[0]=1'", "PS4"],
    ["a prefix value", "x='PS4=1' bash -c '(( x ))'", "PS4"],
    ["an env value", "env x='PS4=1' zsh", "PS4"],
    ["an integer declaration's value", "integer x='PS4=1'", "PS4"],
    ["a declare value", "declare x='MODULE_PATH=1'", "MODULE_PATH"],
    ["unset of a subscripted name", "unset 'a[PS4=7]'", "PS4"],
    ["a [[ -v test of a subscripted name", "[[ -v a[PS4=7] ]]", "PS4"],
    ["a test -v of a subscripted name", "test -v 'a[PS4=7]'", "PS4"],
    ["a [ -v test of a subscripted name", "[ -v 'a[PS4=7]' ]", "PS4"],
    ["a bash substring of $@", ": ${@:PS4=7}", "PS4"],
    ["a bash substring of $1", ": ${1:PS4=7}", "PS4"],
    ["an array element's key", "b=([PS4=7]=x)", "PS4"],
    ["an appended array element's key", "b+=([PS4=7]=x)", "PS4"],
    ["a for list word", "for x in 'PS4=7'", "PS4"],
    ["set -- of a word", "set -- 'PS4=7'", "PS4"],
    ["a function argument", "f 'PS4=7'", "PS4"],
    ["zsh print -v of a word", "print -v x 'PS4=7'", "PS4"],
    ["zsh set -A of a word", "set -A b 'PS4=7'", "PS4"],
    ["a herestring", "read x <<< 'PS4=7'", "PS4"],
    ["zsh ||= in a value", "x='PS4||=7'", "PS4"],
    ["zsh &&= in a value", "x='PS4&&=7'", "PS4"],
    ["zsh ^^= in a value", "x='PS4^^=7'", "PS4"],
    ["any literal word that assigns, an accepted over-read in a commit message", "git commit -m 'set PS4=1'", "PS4"],
    ["a double-quoted value with an expansion", 'x="PS4=$v"', "PS4"],
    ["a double-quoted function argument", 'f "PS4=$v"', "PS4"],
    ["a double-quoted for list word", 'for x in "PS4=$v"', "PS4"],
    ["a double-quoted herestring", 'read x <<< "PS4=$v"', "PS4"],
    ["an alternate value", 'f "${v:+PS4=7}"', "PS4"],
    ["select's list", "select x in 'PS4=7'", "PS4"],
    ["zsh l flag padding text, an accepted over-read", ": ${(l:5::PS4=1:)x}", "PS4"],
    ["a zsh subscript read of module_path, an accepted over-read", "echo $module_path[1]", "module_path"],
  ])("counts as a hooked write: %s", (_how, line, name) => {
    expect(hooked(line)).toBe(name);
  });

  it.each([
    ["(( MODULE_PATH = 1 ))", "MODULE_PATH = 1", "MODULE_PATH"],
    ["(( y, PS4=1 ))", "y, PS4=1", "PS4"],
    ["a for (( )) step", "PS4=0; PS4<1; PS4++", "PS4"],
  ])("reads a (( )) span the walk passes: %s", (_how, expression, name) => {
    expect(arithmeticHooked(expression)).toBe(name);
  });

  it.each([
    ["let of another name", "let i=i+1"],
    ["$(( )) of other names", "echo $(( i + 1 ))"],
    ["a subscript of another name", "echo ${a[i]}"],
    ["a substring of PS4 itself", "echo ${PS4:0:1}"],
    ["a numeric [[ test of another name", "[[ $n -eq 1 ]]"],
    ["a string [[ test naming PS4", "[[ $x == PS4 ]]"],
    ["a declare without -i", "declare x=i+1"],
    ["single-quoted arithmetic reading PS4 in a commit message", "git commit -m 'show $(( PS4 + 1 ))'"],
    ["a literal subscript in an echo operand", "echo a[PS4]"],
    ["a longer name in let", "let PS44=1"],
    ["[ ] numeric test, which does not evaluate", "[ PS4=1 -eq 1 ]"],
    ["test -eq, which does not evaluate", "test PS4=1 -eq 1"],
    ["printf %s of a word naming PS4", "printf '%s\\n' PS4"],
    ["shift by a number", "shift 2"],
    ["return of a status", "return $?"],
    ["a value naming PS4 without assigning", "x='PS4'"],
    ["a value comparing PS4", "x='PS4 == 1'"],
    ["a value of a longer name", "x='PS44=1'"],
    ["zsh l flag of a plain width", ": ${(l:10:)x}"],
  ])("returns null: %s", (_how, line) => {
    expect(hooked(line)).toBeNull();
  });

  it("returns null for a (( )) span of other names", () => {
    expect(arithmeticHooked("i = i + 1")).toBeNull();
  });

  it("reads a long word in linear time", () => {
    const value = `$((${"a[".repeat(30_000)}`;
    const word: WordToken = { type: "word", value, dynamic: true, quoted: false, spliced: false, computed: true, refs: [], subs: [] };
    const started = performance.now();

    writesHookedParam({ name: ":", path: ":", args: [word], assigned: [] }, [word]);

    expect(performance.now() - started).toBeLessThan(100);
  });
});
