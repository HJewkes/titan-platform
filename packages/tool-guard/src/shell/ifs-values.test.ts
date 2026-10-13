import { describe, expect, it } from "vitest";
import { DEFAULT_IFS, lineIfsValues } from "./ifs-values.js";
import { tokenize } from "./lexer.js";

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
    ["a := default", ": ${IFS:=,}"],
    ["an = default", ": ${IFS=,}"],
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
