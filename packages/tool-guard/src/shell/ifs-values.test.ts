import { describe, expect, it } from "vitest";
import { DEFAULT_IFS, lineIfsValues } from "./ifs-values.js";
import { tokenize } from "./lexer.js";
import { ParseError } from "./parse-error.js";

const values = (line: string) => lineIfsValues(tokenize(line));

describe("lineIfsValues on assignments the line spells out", () => {
  it.each([
    ["a standalone assignment", "IFS=,; x", [","]],
    ["a prefix assignment", "IFS=: read a b", [":"]],
    ["an assignment late in a loop body", "for i in 1; do :; IFS=:; done", [":"]],
    ["an assignment in a function defined before its call", "f(){ IFS=,; }; f", [","]],
    ["a local with an ANSI-C value", "f(){ local IFS=$'\\t'; }", ["\t"]],
    ["a quoted value with a blank", "IFS=', '", [", "]],
    ["an escaped value", "IFS=\\,", [","]],
    ["a quoted export argument", "export \"IFS=,\"", [","]],
    ["a declarer behind command", "command declare 'IFS=, '", [", "]],
    ["a declare with an option", "declare -x IFS=';'", [";"]],
    ["a for IFS in list", "for IFS in , :; do :; done", [",", ":"]],
    ["a for IFS in list ended by a newline", "for IFS in ,\ndo :; done", [","]],
    ["an assignment inside a command substitution", "echo \"$(IFS=,; x)\"", [","]],
    ["an assignment inside a process substitution", "cat <(IFS=:; x)", [":"]],
  ])("finds %s", (_how, line, expected) => {
    expect(values(line)).toEqual([DEFAULT_IFS, ...expected]);
  });
});

describe("lineIfsValues on shell text run by eval or sh -c", () => {
  it.each([
    ["eval with a bare assignment", "eval 'IFS=,'", [","]],
    ["sh -c with a script", "bash -c \"IFS=:; x\"", [":"]],
    ["eval with a following command", "eval 'IFS=,; true'", [","]],
    ["eval nested two deep", "eval \"eval 'IFS=,'\"", [","]],
    ["eval with a partly quoted operand", "eval IF'S=,; x'", [","]],
    ["eval with an escaped blank", "eval IFS=a\\ b", ["a"]],
    ["eval joining its operands", "eval IFS=, x", [","]],
    ["bash -c with an escaped separator", "bash -c IFS=,\\;x", [","]],
    ["eval with an ANSI-C spelled name", "eval $'\\x49FS=,'", [","]],
  ])("finds %s", (_how, line, expected) => {
    expect(values(line)).toEqual([DEFAULT_IFS, ...expected]);
  });

  it("gives up three texts deep", () => {
    expect(values("eval \"eval 'eval \\\"eval IFS=,\\\"'\"")).toBeNull();
  });

  it("gives up on text that names IFS but does not parse", () => {
    expect(values("eval 'IFS=, $(' ; IFS=:")).toBeNull();
  });
});

describe("lineIfsValues on lines that keep only the default", () => {
  it.each([
    ["a line with no IFS", "git push origin HEAD:main"],
    ["a name that only contains IFS", "MYIFS=,; IFS_OLD=: x"],
    ["the empty IFS of a read loop", "while IFS= read -r l; do :; done"],
    ["unset IFS", "unset IFS"],
    ["unset with an option", "unset -v IFS"],
    ["a local IFS with no value", "f(){ local IFS; }"],
    ["a literal arithmetic command", "IFS=; (( i = 1 ))"],
    ["a literal arithmetic expansion", "IFS=; : $((i + 1))"],
    ["a literal arithmetic for", "IFS=; for (( i=0; i<3; i++ )); do :; done"],
    ["an export with a literal name and a dynamic value", "IFS=; export PATH=\"$HOME/bin\""],
  ])("gives only the default for %s", (_how, line) => {
    expect(values(line)).toEqual([DEFAULT_IFS]);
  });

  it("lists each value once, in the order the line first assigns it", () => {
    expect(values("IFS=:; IFS=,; for IFS in , ' ' :; do :; done; IFS=$' \\t\\n'")).toEqual([DEFAULT_IFS, ":", ",", " "]);
  });
});

describe("lineIfsValues on IFS writes it cannot resolve to a literal", () => {
  it.each([
    ["an append in a loop", "for i in 1 2; do $E; IFS+=,; done"],
    ["an exported append", "export IFS+=,"],
    ["a subscripted assignment", "IFS[0]=,"],
    ["printf -v", "printf -v IFS ,"],
    ["read", "read IFS <<< ,"],
    ["read with no input", "read IFS"],
    ["mapfile", "mapfile -t IFS <<< ,"],
    ["arithmetic", ": $((IFS=1))"],
    ["select", "select IFS in ,; do :; done"],
    ["a nameref", "declare -n r=IFS; r=,"],
    ["a declarer whose name comes from a variable", "x=IFS; declare \"$x=,\""],
    ["a value from a variable", "IFS=$V; x"],
    ["a value from a command substitution", "IFS=$(printf ,); x"],
    ["a dynamic for IFS in list", "for IFS in $L; do :; done"],
    ["for IFS over the positional parameters", "for IFS; do :; done"],
    ["a dynamic command word that may be a declarer", "x=declare; $x 'IFS=, '"],
    ["a read of IFS", "old=$IFS"],
    ["eval of a brace-spelled name", "eval {I,}FS=,"],
    ["export of a brace-spelled name", "export {I,}FS=,"],
    ["read of a brace-spelled name", "read {I,}FS"],
    ["eval of a brace with an escaped close", "eval {I,\\}}FS=,"],
    ["declare of a brace with an escaped close", "declare {I,\\}}FS=,"],
    ["read of a name built from a variable", "x=IF; read ${x}S"],
    ["declare of a name built from a variable", "declare \"${x}S=,\""],
    ["a nameref built from a variable", "declare -n r=${x}FS"],
    ["printf -v of a name built from a variable", "printf -v \"${x}S\" ,"],
    ["eval of dynamic text that may name IFS", "eval \"IFS=$V\""],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });
});

describe("lineIfsValues on code run from text it cannot read", () => {
  it.each([
    ["eval of a quoted variable", "v=IFS=,; eval \"$v\""],
    ["eval of an unquoted variable", "eval $v"],
    ["eval behind command", "command eval \"$v\""],
    ["bash -c with a dynamic script", "bash -c \"$v; \\$E\""],
    ["eval of a name built from parts", "a=I; b=FS=,; eval \"$a$b\""],
    ["eval of a command substitution", "eval \"$(printf %sFS=, I)\""],
    ["eval of an indirect expansion", "eval \"${!p}\""],
    ["eval nested in literal text", "eval 'eval \"$v\"'"],
    ["the done-when line, whose eval text comes from a variable", "E=gh,pr,merge,1; f(){ eval $E; }; IFS=,; f"],
    ["source from a here-string", "source /dev/stdin <<< IFS=,"],
    ["dot from a quoted here-string", ". /dev/stdin <<< 'IFS=,'"],
    ["an array subscript that assigns IFS", "a[IFS=1]=x"],
    ["a declared array subscript that assigns IFS", "declare a[IFS=1]=x"],
    ["an array subscript with a dynamic name", "a[$n]=x"],
    ["an arithmetic command with a dynamic name", "(( $n = 1 ))"],
    ["an arithmetic expansion with a dynamic name", ": $(( $n = 1 ))"],
    ["an old-style arithmetic expansion with a dynamic name", "x=$[ $n = 1 ]"],
    ["an arithmetic for with a dynamic name", "for (( i=$n; i<3; i++ )); do :; done"],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });
});

describe("lineIfsValues on stored text that may name IFS", () => {
  it.each([
    ["a trap running a stored value", "v=IFS=,; trap \"$v\" DEBUG"],
    ["a trap running a dynamic value", "trap -- \"$v\" RETURN"],
    ["an arithmetic command reading a stored value", "v=IFS=1; (( v ))"],
    ["an arithmetic expansion reading a stored value", "v=IFS=1; : $(( v ))"],
    ["a subscript reading a stored value", "v=IFS=1; a[v]=x"],
    ["let reading a stored value", "v=IFS=1; let v"],
    ["a conditional reading a stored value", "v=IFS=1; [[ v -eq 1 ]]"],
    ["a substring offset reading a stored value", "v=IFS=1; : ${x:v}"],
    ["a prompt expansion of stored arithmetic", "v='$((IFS=1))'; : \"${v@P}\""],
    ["a prompt expansion of a stored default", "v='${IFS:=,}'; : \"${v@P}\""],
    ["a here-string script", "bash <<< 'IFS=,'"],
    ["a here-string from a variable", "bash -s <<< \"$v\""],
    ["a script from a process substitution", "bash <(printf %s \"$v\")"],
    ["an alias from a variable", "alias x=\"$v\""],
    ["exec of a dynamic script", "exec bash -c \"$v\""],
    ["coproc of a dynamic eval", "coproc eval \"$v\""],
    ["a heredoc script", "bash <<EOF\nIFS=,\nEOF"],
    ["a for list storing IFS-like text", "for v in IFS=1; do (( v )); done"],
    ["a declared value that may name IFS", "declare v=IFS=1"],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });
});

describe("lineIfsValues on ordinary lines beside an IFS assignment", () => {
  it.each([
    ["a dynamic argument to an ordinary command", "IFS=,; git push origin \"$b\"", ","],
    ["read from a dynamic here-string", "IFS=, read -r a b <<< \"$line\"", ","],
    ["a literal trap", "IFS=,; trap 'rm -f x' EXIT", ","],
    ["exec of a literal command", "IFS=:; exec git status", ":"],
    ["a process substitution for an ordinary command", "IFS=,; diff <(ls a) <(ls b)", ","],
    ["a stored command substitution", "IFS=,; d=$(date)", ","],
    ["literal arithmetic on a stored number", "IFS=,; v=1; (( v ))", ","],
    ["a heredoc for an ordinary command", "IFS=,; cat <<EOF\nhello\nEOF", ","],
  ])("resolves %s", (_how, line, ifs) => {
    expect(values(line)).toEqual([DEFAULT_IFS, ifs]);
  });
});

describe("lineIfsValues on run-time values read by name", () => {
  it.each([
    ["a command substitution read by arithmetic", "v=$(printf %sFS=1 I); (( v ))"],
    ["an expanded value read by prompt expansion", "v=$x; : \"${v@P}\""],
    ["read input run by a trap", "read v; trap \"$v\" EXIT"],
    ["read input stored as a literal trap body", "read v; trap 'eval \"$v\"' EXIT"],
    ["an expanded value read by let", "v=$x; let v"],
    ["read input read by a conditional", "read v; [[ v -eq 1 ]]"],
    ["an expanded value read as a subscript", "v=$x; a[v]=1"],
    ["an expanded value read as a substring offset", "v=$(cat f); : ${y:v}"],
    ["an expanded value read as an expansion subscript", "v=$x; : ${a[v]}"],
    ["a dynamic for list read by arithmetic", "for v in $L; do (( v )); done"],
    ["read input read by an integer declaration", "declare -i n; read n"],
    ["mapfile input read by an arithmetic expansion", "mapfile -t v < f; : $(( v ))"],
    ["printf -v read by arithmetic", "printf -v v %s \"$x\"; (( v ))"],
    ["a declared expanded value read by arithmetic", "local v=$x; (( v ))"],
    ["a reader before the store, as a loop runs it", "for i in 1 2; do (( v )); v=$x; done"],
    ["a reader in a function called after the store", "f(){ (( v )); }; v=$x; f"],
    ["an expanded value read through a dynamic command", "v=$x; $cmd v"],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });
});

describe("lineIfsValues on run-time values no reader evaluates", () => {
  it.each([
    ["a command substitution used as a default", "IFS=,; d=$(date); echo \"${d:-x}\""],
    ["read input echoed", "IFS=,; read -r a; echo \"$a\""],
    ["literal arithmetic with no run-time value", "IFS=,; v=1; (( v ))"],
    ["a run-time value beside a literal subscript", "IFS=,; a[0]=$x"],
  ])("resolves %s", (_how, line) => {
    expect(values(line)).toEqual([DEFAULT_IFS, ","]);
  });
});

describe("lineIfsValues on subscripted names and indirection", () => {
  const k = "k=$(printf %sFS=1 I); ";
  it.each([
    ["read into a subscripted name", `${k}read 'a[k]'`],
    ["printf -v into a subscripted name", `${k}printf -v 'a[k]' x`],
    ["unset of a subscripted name", `${k}unset 'a[k]'`],
    ["a [[ -v ]] test of a subscripted name", `${k}[[ -v a[k] ]]`],
    ["a test -v of a subscripted name", `${k}test -v 'a[k]'`],
    ["an indirect expansion", `${k}: "\${!k}"`],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });
});

describe("lineIfsValues on shells that source a startup file", () => {
  it.each([
    ["BASH_ENV as a prefix", "BASH_ENV=/tmp/x bash -c :"],
    ["BASH_ENV exported", "export BASH_ENV=/tmp/x; bash -c :"],
    ["BASH_ENV through env", "env BASH_ENV=/tmp/x bash -c :"],
    ["ENV for sh", "ENV=/tmp/x sh -c :"],
    ["--rcfile", "bash --rcfile /tmp/x -i"],
    ["--init-file", "bash --init-file /tmp/x"],
    ["a login shell", "bash -lc :"],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });
});

describe("lineIfsValues on namerefs given a run-time target", () => {
  it.each([
    ["a nameref as a for variable over a dynamic list", "declare -n r; for r in $L; do r=,; done"],
    ["a nameref as a for variable over a literal list", "declare -n r; for r in a b; do r=,; done"],
    ["a nameref assigned a dynamic value", "declare -n r; r=$x; r=,"],
    ["a local nameref read into", "f(){ local -n r; read r; r=,; }"],
    ["a nameref assigned before it is declared, as a loop runs it", "for i in 1 2; do r=$x; typeset -n r; done"],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });
});

describe("lineIfsValues on namerefs and shells it can still read", () => {
  it.each([
    ["a nameref with a literal target", "IFS=,; declare -n r=a; r=1"],
    ["a literal sh -c script", "IFS=,; bash -c 'echo hi'"],
    ["a numeric subscript beside a run-time value", "IFS=,; read -r v; a[1]=x"],
  ])("resolves %s", (_how, line) => {
    expect(values(line)).toEqual([DEFAULT_IFS, ","]);
  });
});

describe("lineIfsValues on unquoted heredoc bodies", () => {
  const k = "k=$(printf %sFS=1 I); ";
  it.each([
    ["an arithmetic expansion", `${k}cat <<EOF\n$(( k ))\nEOF`],
    ["a substring offset", `${k}cat <<EOF\n\${x:k}\nEOF`],
    ["arithmetic on names built from parts", "a=I; b=FS=1; cat <<EOF\n$(( $a$b ))\nEOF"],
    ["a tab-stripped heredoc", `${k}cat <<-EOF\n\t$(( k ))\nEOF`],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });

  it.each([
    ["a quoted delimiter", `IFS=,; ${k}cat <<'EOF'\n$(( k )) \${x:k} \${!k:=,}\nEOF`],
    ["an escaped delimiter", `IFS=,; ${k}cat <<\\EOF\n$(( k ))\nEOF`],
    ["an unquoted body that only expands values", `IFS=,; ${k}cat <<EOF\n$k \${k:-x}\nEOF`],
  ])("keeps %s literal", (_how, line) => {
    expect(values(line)).toEqual([DEFAULT_IFS, ","]);
  });
});

describe("lineIfsValues on compound-array subscripts", () => {
  const k = "k=$(printf %sFS=1 I); ";
  it.each([
    ["an array assignment", `${k}a=([k]=1)`],
    ["an array append", `${k}a+=([k]=1)`],
    ["a declared array", `${k}declare -a a=([k]=1)`],
    ["a dynamic subscript", "a=([$k]=1)"],
    ["a subscript that may name IFS", "a=([IFS=1]=1)"],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });

  it("resolves numeric subscripts beside a run-time value", () => {
    expect(values(`IFS=,; ${k}a=([0]=1 [2]=x)`)).toEqual([DEFAULT_IFS, ","]);
  });
});

describe("lineIfsValues on PS4, which xtrace expands in the current shell", () => {
  it.each([
    ["a substring offset over a run-time value", "k=$(printf %sFS=1 I); PS4='${x:k}'; set -x; A=push1origin1HEAD:main; git $A"],
    ["arithmetic on names built from parts", "PS4='$(( $a$b ))'; a=I; b=FS=1; set -x; git $A"],
    ["a declared arithmetic prompt set before the run-time value", "declare PS4='$((k))'; k=$(cmd); set -x; git $A"],
    ["an exported prompt from a variable beside a run-time value", "k=$(cmd); export PS4=\"$p\"; set -x; git $A"],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });

  it("resolves a literal prompt", () => {
    expect(values("IFS=,; PS4='+ '; set -x; git $A")).toEqual([DEFAULT_IFS, ","]);
  });
});

describe("lineIfsValues on PS4 written through a name slot", () => {
  const k = "k=$(printf %sFS=1 I); ";
  it.each([
    ["printf -v", `${k}printf -v PS4 %s '$((k))'; set -x; git $A`],
    ["read -r from a here-string", `${k}read -r PS4 <<< '$((k))'; set -x; git $A`],
    ["mapfile from a here-string", `${k}mapfile -t PS4 <<< '$((k))'; set -x; git $A`],
    ["a nameref onto PS4", `${k}declare -n r=PS4; r='$((k))'; set -x; git $A`],
    ["a for loop over PS4", `${k}for PS4 in '$((k))'; do set -x; git $A; done`],
    ["printf -v of arithmetic on names built from parts", "a=I; b=FS=1; printf -v PS4 %s '$(( $a$b ))'; set -x; git $A"],
    ["a for loop over a literal prompt", "for PS4 in '+ '; do set -x; git $A; done"],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });
});

describe("lineIfsValues on PS4 spelled through subscripts, braces and attached options", () => {
  const k = "k=$(printf %sFS=1 I); ";
  const trace = "; set -x; git $A";
  it.each([
    ["read into a PS4 subscript", `${k}read 'PS4[0]' <<< '$((k))'${trace}`],
    ["printf -v into a PS4 subscript", `${k}printf -v 'PS4[0]' %s '$((k))'${trace}`],
    ["a nameref onto a PS4 subscript", `${k}declare -n r=PS4[0]; r='$((k))'${trace}`],
    ["printf with an attached -v", `${k}printf -vPS4 %s '$((k))'${trace}`],
    ["read of a brace-spelled PS4", `${k}read {P,}S4 <<< '$((k))'${trace}`],
    ["printf -v of a brace-spelled PS4", `${k}printf -v P{S,}4 %s '$((k))'${trace}`],
    ["export of a brace-spelled PS4", `${k}export {P,}S4='$((k))'${trace}`],
    ["a nameref onto a brace-spelled PS4", `${k}declare -n r=P{S,}4; r='$((k))'${trace}`],
    ["an empty nameref whose first write targets PS4", `${k}declare -n r; r=PS4; r='$((k))'${trace}`],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });

  it("resolves names that do not spell PS4", () => {
    expect(values("IFS=,; read -r line; printf -v out %s x; declare -n r=a; r=1; set -x; git $A")).toEqual([DEFAULT_IFS, ","]);
  });
});

describe("lineIfsValues on IFS values the shell rewrites at run time", () => {
  it.each([
    ["a bare tilde", "IFS=~; $A"],
    ["a tilde-plus", "cd /; IFS=~+; A=echo/gh/pr/merge/1; $A"],
    ["a tilde after a colon", "IFS=a:~; $A"],
    ["a tilde-minus in a for list", "for IFS in ~-; do $A; done"],
    ["an exported tilde", "export IFS=~; $A"],
    ["a glob in a for list", "for IFS in *; do $A; done"],
    ["a brace list in a for list", "for IFS in {a,b}; do $A; done"],
    ["a brace range in a for list", "for IFS in {1..3}; do $A; done"],
    ["a zsh equals expansion", "IFS==ls; $A"],
    ["a declared glob", "declare IFS=*; $A"],
    ["a quoted tilde, whose quoting the tokens do not keep", "IFS='~'; $A"],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });

  it.each([
    ["a for list of plain separators", "for IFS in , : /; do $A; done", [",", ":", "/"]],
  ])("resolves %s", (_how, line, expected) => {
    expect(values(line)).toEqual([DEFAULT_IFS, ...expected]);
  });
});

describe("lineIfsValues on IFS assignments a declarer attribute transforms", () => {
  it.each([
    ["an earlier uppercase declaration without a value", "declare -u IFS; IFS=x; $A"],
    ["a lowercase declaration", "declare -l IFS; IFS=X; $A"],
    ["a capitalising declaration", "declare -c IFS=xy; $A"],
    ["zsh typeset -u", "typeset -u IFS; IFS=x; $A"],
    ["an integer declaration with arithmetic", "declare -i IFS=2+2; $A"],
    ["a local integer in hex", "f(){ local -i IFS=0x2f; $A; }; f"],
    ["zsh right-justified padding", "typeset -R 3 IFS=x; $A"],
    ["zsh zero padding", "typeset -Z 2 IFS=1; $A"],
    ["an array declaration", "declare -a IFS=(x y); $A"],
    ["an array assignment", "IFS=(x y); $A"],
    ["a cleared attribute that reads the same", "declare +u IFS; IFS=x; $A"],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });

  it("resolves an export or readonly, which do not transform the value", () => {
    expect(values("export IFS=,; declare -rx IFS; $A")).toEqual([DEFAULT_IFS, ","]);
  });
});

describe("lineIfsValues on zsh equals expansion after a colon", () => {
  it.each([
    ["a bare assignment", "IFS=a:=ls; $A"],
    ["an export", "export IFS=a:=ls; $A"],
    ["eval text", "eval 'IFS=a:=ls'; $A"],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });
});

describe("lineIfsValues on single glob characters in a for list", () => {
  it.each([
    ["a question mark", "for IFS in a?; do $A; done"],
    ["an open bracket", "for IFS in a[; do $A; done"],
    ["a zsh caret", "for IFS in a^; do $A; done"],
    ["a zsh hash", "for IFS in a#; do $A; done"],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });
});

describe("lineIfsValues on declarer options outside the safe set", () => {
  it.each([
    ["zsh zero padding with an attached width", "typeset -Z3 IFS=1; $A"],
    ["an attached width declared before the value", "typeset -Z3 IFS; IFS=1; $A"],
    ["zsh left padding with an attached width", "typeset -L3 IFS=x; $A"],
    ["zsh right padding with an attached width", "typeset -R3 IFS=x; $A"],
    ["an option mixing safe and unsafe letters", "declare -xu IFS=x; $A"],
    ["an unknown option letter", "declare -q IFS=x; $A"],
    ["zsh integer", "integer IFS=2+2; $A"],
    ["zsh float", "float IFS=1; $A"],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });

  it.each([
    ["a global export", "declare -gx IFS=,; $A"],
    ["a cleared export", "declare +x IFS=,; $A"],
    ["an end of options", "declare -- IFS=,; $A"],
  ])("resolves %s", (_how, line) => {
    expect(values(line)).toEqual([DEFAULT_IFS, ","]);
  });
});

describe("lineIfsValues on glob characters in an IFS value", () => {
  it.each([
    ["a star under zsh globassign", "IFS=/e*; $A"],
    ["a question mark", "IFS=a?; $A"],
    ["an open bracket", "IFS=[ab]; $A"],
    ["an exported glob", "export IFS=x*; $A"],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });
});

describe("lineIfsValues on IFS values outside the unrewritten character set", () => {
  it.each([
    ["an extendedglob caret", "IFS=a^c; $A"],
    ["an extendedglob hash", "IFS=a#; $A"],
    ["an extendedglob tilde", "IFS=a~b; $A"],
    ["a quoted caret, whose quoting the tokens do not keep", "IFS='a^c'; $A"],
    ["a trailing tilde", "IFS=a~; $A"],
    ["an equals sign that follows no colon", "IFS=a=b; $A"],
    ["a non-ASCII character", "IFS=é; $A"],
  ])("gives null for %s", (_how, line) => {
    expect(values(line)).toBeNull();
  });

  it.each([
    ["each allowed punctuation mark", "IFS=',.:;/_%-'; $A", [",.:;/_%-"]],
    ["letters, digits and blanks", "IFS='a1 '; $A", ["a1 "]],
  ])("resolves %s", (_how, line, expected) => {
    expect(values(line)).toEqual([DEFAULT_IFS, ...expected]);
  });
});

describe("lineIfsValues on an indirect assigning expansion", () => {
  const k = "k=$(printf %sFS=1 I); ";
  it.each([
    ["a default in double quotes", `${k}: "\${!k:=,}"`],
    ["a default in an unquoted heredoc body", `${k}cat <<EOF\n\${!k:=,}\nEOF`],
  ])("is refused by the lexer before it is read: %s", (_how, line) => {
    expect(() => values(line)).toThrow(ParseError);
  });
});

describe("lineIfsValues on a shell named by a variant or a path (TP-3183)", () => {
  it.each([
    ["rzsh", "zsh"],
    ["rbash", "bash"],
    ["rksh", "ksh"],
    ["zsh5", "zsh"],
    ["bash5.2", "bash"],
    ["/bin/rzsh", "zsh"],
  ])("reads the -c text of %s as %s does", (variant, base) => {
    const text = "-c 'IFS=,; x'";
    expect(values(`${variant} ${text}`)).toEqual([DEFAULT_IFS, ","]);
    expect(values(`${variant} ${text}`)).toEqual(values(`${base} ${text}`));
  });

  it.each([
    ["rzsh", "zsh"],
    ["rbash", "bash"],
    ["rksh", "ksh"],
    ["zsh5", "zsh"],
    ["bash5.2", "bash"],
    ["/bin/rzsh", "zsh"],
  ])("gives up on the stdin of %s as it does for %s", (variant, base) => {
    const line = `${variant} <<< "$v"`;
    expect(values(line)).toBeNull();
    expect(values(line)).toEqual(values(`${base} <<< "$v"`));
  });
});
