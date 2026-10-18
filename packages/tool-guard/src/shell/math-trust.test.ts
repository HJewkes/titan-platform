import { describe, expect, it } from "vitest";
import { CommandRebindingError } from "./command-rebinding.js";
import { extractCommands } from "./commands.js";
import { normalizeDeclarations } from "./declarations.js";
import { tokenize } from "./lexer.js";
import { noteLineWrites } from "./math-trust.js";
import { expectLinearTime, LINEARITY_TIMEOUT_MS } from "./test-linearity.js";
import { noteSureCommands } from "./vars.js";

const line = (src: string) => () => extractCommands(src, { arithmetic: true });
const script = (src: string) => () => extractCommands(src, { scriptText: true });

describe("math over a name the line never writes", () => {
  it.each([
    ["$name", "echo $(( $e + 1 ))"],
    ["${name}", "echo $(( ${e} + 1 ))"],
    ["a digit default", "echo $(( ${e:-0} + 1 ))"],
    ["a bare name", "(( e > 0 ))"],
    ["shift by it", 'shift "$e"'],
    ["a positional parameter", "echo $(( $1 * 2 ))"],
    ["a positional parameter through a name", "n=$1; echo $(( n * 2 ))"],
    ["a function the line calls with digits", "f() { local n=$1; echo $(( n * 2 )); }; f 3"],
    ["a counter the shell keeps", "t0=$SECONDS; echo $(( SECONDS - t0 ))"],
    ["a length", "echo $(( ${#PWD} + 1 ))"],
  ])("trusts %s, which holds the Bash tool's environment", (_name, src) => {
    expect(line(src)).not.toThrow();
  });

  it.each([
    ["a word set from a command", "e=$(cat f); echo $(( $e ))"],
    ["a word read from input", "read -r e; echo $(( $e ))"],
    ["a word printf stores", "printf -v e %s x; echo $(( $e ))"],
    ["a default that assigns", ": ${e:=x}; echo $(( $e ))"],
    ["a word set later in a loop", "for i in 1 2; do echo $(( $e )); e='commands[y]=0'; done"],
    ["a word set after a function that reads it is defined", "f() { echo $(( $e )); }; e='commands[y]=0'; f"],
    ["a word eval sets", "eval 'e=$(cat f)'; echo $(( $e ))"],
    ["a word a trap sets", "trap 'e=$(cat f)' DEBUG; echo $(( $e ))"],
    ["any word after run-time eval text", 'eval "$x"; echo $(( $e ))'],
    ["any word after a sourced file", "source ./env.sh; echo $(( $e ))"],
    ["any word after a run-time command word", "$c e; echo $(( $e ))"],
    ["any word behind a nameref", "declare -n r=e; r=$(cat f); echo $(( $e ))"],
    ["a run-time default", "echo $(( ${e:-$(cat f)} ))"],
    ["an operator no rule reads", "echo $(( ${e/a/b} ))"],
    ["an indirect expansion", "echo $(( ${!e} ))"],
    ["an ANSI-C string", "echo $(( $'x' ))"],
    ["a shell-set name", ": x; echo $(( $_ ))"],
    ["a nested shell's environment, which env may set", "env e='commands[y]=0' bash -c 'echo $(( $e ))'"],
    ["a nested shell's environment a prefix sets", "e='commands[y]=0' bash -c 'echo $(( $e ))'"],
    ["any word in a shell that runs a startup file", "BASH_ENV=./f bash -c 'echo $(( $e ))'"],
  ])("refuses %s, which may hold a store", (_name, src) => {
    expect(line(src)).toThrow(CommandRebindingError);
  });
});

describe("the positional parameters", () => {
  it.each([
    ["set --", "set -- 'commands[y]=0'; echo $(( $1 ))"],
    ["a call of the line's function with text", "f() { echo $(( $1 )); }; f 'commands[y]=0'"],
    ["a call the walk cannot see", "f() { echo $(( $1 )); }; $g x"],
    ["a nested shell's arguments", "bash -c 'echo $(( $1 ))' _ 'commands[y]=0'"],
    ["set -- in eval text", "eval 'set -- x'; echo $(( $1 ))"],
    ["a call of the line's function in eval text", "f() { echo $(( $1 )); }; eval \"f 'commands[y]=0'\""],
    ["a zsh argv assignment", "argv=('commands[y]=0'); echo $(( $1 ))"],
    ["a zsh assignment by number", "1='commands[y]=0'; echo $(( $1 ))"],
    ["a zsh read into argv", "read -A argv; echo $(( $1 ))"],
  ])("refuses them after %s", (_name, src) => {
    expect(line(src)).toThrow(CommandRebindingError);
  });

  it("trusts them after set with options only", () => {
    expect(line("set -euo pipefail; echo $(( $1 ))")).not.toThrow();
  });
});

describe("a substitution in math", () => {
  it.each([
    ["a date", "echo $(( $(date +%s) - $start ))"],
    ["a count through a pipe", "echo $(( $(git status --porcelain | wc -l) + 0 ))"],
    ["a base number", "echo $(( 10#$(date +%H) + 1 ))"],
    ["a name set from one", "n=$(nproc); make -j$(( n + 1 ))"],
    ["a loop over one", "for i in $(seq 1 3); do echo $(( i * 2 )); done"],
  ])("trusts %s, whose output is digits", (_name, src) => {
    expect(line(src)).not.toThrow();
  });

  it.each([
    ["a file's contents", "echo $(( $(cat count) + 1 ))"],
    ["a date with text", "echo $(( $(date +%F) ))"],
    ["a date the line redefines", "date() { echo 'commands[y]=0'; }; echo $(( $(date +%s) ))"],
    ["a count the line redefines", "wc() { cat f; }; echo $(( $(wc -l < g) ))"],
  ])("refuses %s", (_name, src) => {
    expect(line(src)).toThrow(CommandRebindingError);
  });
});

describe("a script the line runs", () => {
  it.each([
    ["a name it never writes", "echo $(( $e ))"],
    ["a positional parameter", "echo $(( $1 ))"],
  ])("refuses %s, which the line may have set", (_name, src) => {
    expect(script(src)).toThrow(CommandRebindingError);
  });

  it.each([
    ["a name it writes as a number", "i=0; echo $(( i + 1 ))"],
    ["a counter", "echo $(( SECONDS ))"],
    ["OPTIND after getopts", "while getopts ab o; do :; done; shift $((OPTIND-1))"],
  ])("trusts %s", (_name, src) => {
    expect(script(src)).not.toThrow();
  });
});

describe("a store spelled across the text around a piece", () => {
  it.each([
    ["a name spliced before an assignment", "x='commands[y]'; (( $x = 0 ))"],
    ["a name spliced after the parameter", "x='[y]=0'; (( commands$x ))"],
    ["an increment spliced after an element", "x='++'; echo $(( commands[y]$x ))"],
    ["a default spliced after the parameter", "echo $(( commands${e:-[y]=0} ))"],
    ["a (( )) body the lexer splits into words", "(( commands[y] = 0 ))"],
    ["a store after a comma", "(( i = 1, commands[y] = 0 ))"],
    ["a space before the subscript", "echo $(( commands [y] = 0 ))"],
  ])("refuses %s", (_name, src) => {
    expect(line(src)).toThrow(CommandRebindingError);
  });

  it.each([
    ["a name holding digits", "x=5; echo $(( $x + 1 ))"],
    ["a status kept in a name", "make; rc=$?; exit $rc"],
  ])("passes %s", (_name, src) => {
    expect(line(src)).not.toThrow();
  });
});

describe("the line's writes", () => {
  const noteWrites = (src: string) => {
    const tokens = noteSureCommands(normalizeDeclarations(tokenize(src)));
    return () => noteLineWrites(tokens, new Map());
  };

  it.each([
    ["many writes to one name", (n: number) => "e=1; ".repeat(n)],
    ["a call of a defined function with many words", (n: number) => `f() { :; }; f ${"x ".repeat(n)}`],
    ["many words that name a defined function", (n: number) => `f() { :; }; echo ${"f ".repeat(n)}`],
  ])("are read in linear time: %s", (_name, build) => {
    expectLinearTime((n) => noteWrites(build(n)), 8_000);
  }, LINEARITY_TIMEOUT_MS);
});
