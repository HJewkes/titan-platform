import { describe, expect, it } from "vitest";
import { classify } from "./classify.js";
import { nodeContext } from "./context.js";

const HOME = "/home/you";
// A sourced `./f` exists and is harmless, so the rows that source it reach the `[[` rather than stopping at an unreadable script.
const SOURCED = "/home/you/projects/app/f";
const ctx = nodeContext(HOME, { realpath: (p) => p, readHead: (p) => (p === SOURCED ? ":\n" : "feat/x"), isFile: (p) => p === SOURCED });
const PUSH = "git push origin HEAD:main";
const event = (command: string) => ({ kind: "bash" as const, command, cwd: "/home/you/projects/app", toolName: "Bash", sessionId: "s", toolUseId: "t" });
const spellings = (command: string) => classify(event(command), ctx).map((a) => a.spelling);
const SCRIPT = "/home/you/projects/app/x.sh";
const withScript = (text: string) => nodeContext(HOME, { realpath: (p) => p, readHead: (p) => (p === SCRIPT ? text : "feat/x"), isFile: (p) => p === SCRIPT });
const scriptSpellings = (command: string, text: string) => classify(event(command), withScript(text)).map((a) => a.spelling);

describe("a [[ is joined only where the text is read as bash, zsh or ksh", () => {
  it.each([
    `sh -c '[[ a || ${PUSH} ]]'`,
    `dash -c '[[ a || ${PUSH} ]]'`,
    `env sh -c '[[ a || ${PUSH} ]]'`,
    `echo '[[ a || ${PUSH} ]]' | sh`,
    `sh <<<'[[ a || ${PUSH} ]]'`,
    `bash -c 'sh -c "[[ a || ${PUSH} ]]"'`,
  ])("reports the push in %j", (command) => {
    expect(spellings(command)).toContain("bash.merge.git-push-protected");
  });

  it.each([
    `shopt -s expand_aliases\nalias '[['=false\n[[ a || ${PUSH} ]]`,
    `alias '[['=false; eval '[[ a || ${PUSH} ]]'`,
    `al""ias '[['=false; [[ a || ${PUSH} ]]`,
    `\\alias '[['=false; [[ a || ${PUSH} ]]`,
    `a=alias; $a '[['=false; [[ a || ${PUSH} ]]`,
    `shopt -s expand_al""iases; [[ a || ${PUSH} ]]`,
  ])("reports the push on a line that may define an alias: %j", (command) => {
    expect(spellings(command)).toContain("bash.merge.git-push-protected");
  });

  it.each([
    `a=ali; b=as; $a$b '[['=false; eval '[[ a || ${PUSH} ]]'`,
    `a=ali; b=as; $a$b '[['=false; [[ a || ${PUSH} ]]`,
    `$(printf '\\x61lias') '[['=false; [[ a || ${PUSH} ]]`,
    `x=$'\\x61lias'; $x '[['=false; [[ a || ${PUSH} ]]`,
    `o=expand_aliases; p=; shopt -s $o$p; [[ a || ${PUSH} ]]`,
    `shopt -s $o$p\n[[ a || ${PUSH} ]]`,
    `setopt $o; [[ a || ${PUSH} ]]`,
    `. ./f; [[ a || ${PUSH} ]]`,
    `. ./f; eval '[[ a || ${PUSH} ]]'`,
    `source ./f; bash -c '[[ a || ${PUSH} ]]'`,
    `read "$n$m[[["; [[ a || ${PUSH} ]]`,
    `declare "$n"; [[ a || ${PUSH} ]]`,
    `printf -v "$n" x; [[ a || ${PUSH} ]]`,
    `$x; [[ a || ${PUSH} ]]`,
    `command $x; [[ a || ${PUSH} ]]`,
    `eval '[[ a || ${PUSH} ]]'`,
    `bash -c 'eval "[[ a || ${PUSH} ]]"'`,
    `echo $(. ./f); [[ a || ${PUSH} ]]`,
    `disable -r '[['\n[[ a || ${PUSH} ]]`,
    `disable -r "[["; setopt no_bad_pattern; eval "[[ a || ${PUSH} ]]"`,
    `zsh -c 'disable -r "[["; setopt no_bad_pattern; eval "[[ a || ${PUSH} ]]"'`,
    `zsh -f <<'EOF'\ndisable -r '[['\nunsetopt badpattern nomatch\n[[ a || ${PUSH} ]]\nEOF`,
    `printf '%s\\n' "disable -r '[['" "unsetopt badpattern nomatch" "[[ a || ${PUSH} ]]" | zsh -f`,
    `echo "disable -r '[['; [[ a || ${PUSH} ]]" | zsh -f`,
    `enable -n '[['; [[ a || ${PUSH} ]]`,
  ])("reports the push when a step before the [[ cannot be read: %j", (command) => {
    expect(spellings(command)).toContain("bash.merge.git-push-protected");
  });

  it.each([
    `d=$(pwd); echo $d; [[ -n $d && a || ${PUSH} ]]`,
    `echo $x && [[ a || ${PUSH} ]]`,
    `bash -c '[[ a || ${PUSH} ]]'`,
  ])("keeps the joined reading when every step is readable: %j", (command) => {
    expect(spellings(command)).toEqual([]);
  });

  it.each([`[[ a || ${PUSH} ]]`, `bash -c '[[ a || b ]]'`, `zsh -c '[[ a || b ]]'`])("still joins a bash or zsh [[ in %j", (command) => {
    expect(spellings(command)).toEqual([]);
  });

  it.each([
    ["sh ./x.sh", `[[ a || ${PUSH} ]]`],
    ["dash x.sh", `[[ a || ${PUSH} ]]`],
    ["sh < x.sh", `[[ a || ${PUSH} ]]`],
    ["./x.sh", `#!/bin/sh\n[[ a || ${PUSH} ]]`],
    ["bash x.sh", `[[ a || ${PUSH} ]]`],
    ["source x.sh", `[[ a || ${PUSH} ]]`],
  ])("reports the push in a script file %j runs, whose runner the line does not fix", (command, text) => {
    expect(scriptSpellings(command, text)).toContain("bash.merge.git-push-protected");
  });

  it.each([
    `BASH_ENV=./e bash -c '[[ a || ${PUSH} ]]'`,
    `export BASH_ENV=./e; bash -c '[[ a || ${PUSH} ]]'`,
    `BASH_ENV=./e; export BASH_ENV; bash -c '[[ a || ${PUSH} ]]'`,
    `ZDOTDIR=./d zsh -c '[[ a || ${PUSH} ]]'`,
    `export ZDOTDIR=./d; zsh -c '[[ a || ${PUSH} ]]'`,
    `bash --init-file ./e -c '[[ a || ${PUSH} ]]'`,
    `bash --rcfile ./e -i -c '[[ a || ${PUSH} ]]'`,
    `HOME=./d bash -l -c '[[ a || ${PUSH} ]]'`,
    `HOME=./d zsh -c '[[ a || ${PUSH} ]]'`,
    `bash -l -c '[[ a || ${PUSH} ]]'`,
    `zsh -o login -c '[[ a || ${PUSH} ]]'`,
    `exec -a -bash bash -c '[[ a || ${PUSH} ]]'`,
    `bash -c 'BASH_ENV=./e bash -c "[[ a || ${PUSH} ]]"'`,
    `HOME=./d zsh -f <<'EOF'\n[[ a || ${PUSH} ]]\nEOF`,
    `echo '[[ a || ${PUSH} ]]' | zsh -i`,
    `o=-l; bash $o -c '[[ a || ${PUSH} ]]'`,
    `o=--login; bash "$o" -c '[[ a || ${PUSH} ]]'`,
  ])("reports the push when the line may choose a startup file: %j", (command) => {
    expect(spellings(command)).toContain("bash.merge.git-push-protected");
  });

  it("joins a plain [[ on the Bash tool's own line", () => {
    expect(spellings(`[[ -n x && a || ${PUSH} ]]`)).toEqual([]);
  });

  it.each([`bash -ec '[[ a || ${PUSH} ]]'`, `zsh -f <<'EOF'\n[[ a || ${PUSH} ]]\nEOF`])("still joins a shell with only plain options in %j", (command) => {
    expect(spellings(command)).toEqual([]);
  });
});
