import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifyContext } from "../types.js";

const REPO = "/home/you/projects/app";
const ctx: ClassifyContext = { home: "/home/you", readLink: () => null, readHead: () => "feat/x", readScript: () => null };

const verdicts = (command: string) =>
  classify({ kind: "bash", command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null }, ctx).map((a) => [a.spelling, a.subject]);
const spellings = (command: string) => verdicts(command).map(([s]) => s);

const UNKNOWN_PUSH = ["bash.merge.git-push-protected", { branch: "unknown" }];

describe("a dynamic command word typed directly", () => {
  it.each([
    ["quoted", "\"$G\" push origin HEAD:main"],
    ["unquoted", "$G push origin HEAD:main"],
  ])("fails closed as a protected push: %s", (_how, command) => {
    expect(verdicts(command)).toContainEqual(UNKNOWN_PUSH);
  });

  it("keeps the exact subject once the variable is pinned", () => {
    expect(verdicts("G=git; $G push origin HEAD:main")).toEqual([["bash.merge.git-push-protected", { branch: "main" }]]);
  });

  it("fails closed when the word after it is dynamic too", () => {
    expect(verdicts("\"$G\" \"$X\"")).toContainEqual(UNKNOWN_PUSH);
  });
});

describe("a dynamic command word read per guarded family", () => {
  it.each([
    ["direct", "\"$G\" pr merge 5"],
    ["xargs", "xargs \"$G\" pr merge 5"],
    ["xargs with piped input", "echo x | xargs \"$G\" pr merge 5"],
  ])("reads pr merge as gh pr merge, not a push: %s", (_how, command) => {
    expect(spellings(command)).toContain("bash.merge.gh-pr-merge");
    expect(spellings(command)).not.toContain("bash.merge.git-push-protected");
  });

  it.each([
    ["direct", "\"$G\" release create v1"],
    ["xargs", "xargs \"$G\" release create v1"],
  ])("reads release create as gh release: %s", (_how, command) => {
    expect(spellings(command)).toContain("bash.release.gh-release");
    expect(spellings(command)).not.toContain("bash.merge.git-push-protected");
  });

  it("reads publish as a release tool's publish", () => {
    expect(spellings("\"$P\" publish")).toContain("bash.release.npm-publish");
  });
});

describe("a dynamic command word that names no guarded verb", () => {
  it.each([
    ["an editor on a file", "\"$EDITOR\" file"],
    ["a version flag", "\"$CMD\" --version"],
    ["xargs with static input", "echo a.txt | xargs \"$EDITOR\""],
    ["xargs with static input and an argument", "printf 'a\\n' | xargs \"$X\" -n1 --version"],
  ])("gives no verdict: %s", (_how, command) => {
    expect(verdicts(command)).toEqual([]);
  });

  it("still fails closed under xargs when the input cannot be read", () => {
    expect(verdicts("xargs \"$EDITOR\"")).toContainEqual(UNKNOWN_PUSH);
  });
});
