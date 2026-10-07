import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifyContext } from "../types.js";

const REPO = "/home/you/projects/app";
const ctx: ClassifyContext = { home: "/home/you", readLink: () => null, readHead: () => "feat/x", readScript: () => null };

const verdicts = (command: string) =>
  classify({ kind: "bash", command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null }, ctx).map((a) => [a.spelling, a.subject]);
const spellings = (command: string) => verdicts(command).map(([s]) => s);

const PROTECTED_PUSH = "bash.merge.git-push-protected";
const MAIN_PUSH = [PROTECTED_PUSH, { branch: "main" }];

describe("xargs with no pipe into it", () => {
  it.each([
    ["a dynamic word among a wrapper's options", "xargs timeout $O 5 git push origin HEAD:main"],
    ["a dynamic replace string in the refspec", "xargs -I $R git push origin $R"],
    ["a replace string in the refspec", "xargs -I % git push origin %"],
  ])("reads a push as protected: %s", (_how, command) => {
    expect(spellings(command)).toContain(PROTECTED_PUSH);
  });
});

describe("a dynamic word a wrapper reads as its positional", () => {
  it.each([
    ["typed directly", "timeout $O 5 git push origin HEAD:main"],
    ["under xargs with piped input", "printf 'x\\n' | xargs timeout $O 5 git push origin HEAD:main"],
  ])("may be an option, so the command after it still runs: %s", (_how, command) => {
    expect(verdicts(command)).toContainEqual(MAIN_PUSH);
  });

  it("passes a push to an unprotected branch", () => {
    expect(verdicts("timeout $O 5 git push origin feat/y")).toEqual([]);
  });
});

describe("a dynamic command word behind a wrapper", () => {
  it.each([
    ["sudo", "sudo $G push origin HEAD:main"],
    ["timeout, quoted", "timeout 5 \"$G\" push origin HEAD:main"],
  ])("reads it as a direct dynamic word is read: %s", (_how, command) => {
    expect(verdicts(command)).toContainEqual(MAIN_PUSH);
  });

  it("keeps the piped input of an xargs after it", () => {
    expect(verdicts("printf 'HEAD:main\\n' | sudo $a xargs -I % git push origin %")).toContainEqual(MAIN_PUSH);
  });

  it("reads that piped input exactly, so a push to an unprotected branch passes", () => {
    expect(verdicts("printf 'HEAD:feat/y\\n' | sudo $a xargs -I % git push origin %")).toEqual([]);
  });
});

describe("a wrapper or xargs that runs nothing guarded", () => {
  it.each([
    ["xargs echo of a dynamic replace string", "xargs -I $R echo $R"],
    ["sudo of a dynamic word's status", "sudo $G status"],
    ["plain xargs echo", "xargs echo hi"],
    ["plain sudo", "sudo ls"],
  ])("gives no verdict: %s", (_how, command) => {
    expect(verdicts(command)).toEqual([]);
  });
});
