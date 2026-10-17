import { describe, expect, it } from "vitest";
import { classify } from "./classify.js";
import { nodeContext } from "./context.js";

const HOME = "/home/you";
const ctx = nodeContext(HOME, { realpath: (p) => p, readHead: () => "feat/x", isFile: () => false });
const PUSH = "git push origin HEAD:main";
const spellings = (command: string) => classify({ kind: "bash", command, cwd: "/home/you/projects/app", toolName: "Bash", sessionId: "s", toolUseId: "t" }, ctx).map((a) => a.spelling);

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

  it.each([`[[ a || ${PUSH} ]]`, `bash -c '[[ a || b ]]'`, `zsh -c '[[ a || b ]]'`, `eval '[[ a || b ]]'`])("still joins a bash or zsh [[ in %j", (command) => {
    expect(spellings(command)).toEqual([]);
  });
});
