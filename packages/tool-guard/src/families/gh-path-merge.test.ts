import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifiedAction, ClassifyContext } from "../types.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";

function fakeContext(head: string | null): ClassifyContext {
  return { home: HOME, readLink: () => null, readHead: (dir) => (dir === REPO ? head : null), readScript: () => null };
}

function bash(command: string, head: string | null = "feat/x"): ClassifiedAction[] {
  const event = { kind: "bash" as const, command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null };
  return classify(event, fakeContext(head));
}

const spellings = (actions: ClassifiedAction[]) => actions.map((a) => a.spelling);

describe("a gh command whose group or verb is only known at run time", () => {
  const merges = (command: string) => bash(command).filter((a) => a.spelling.startsWith("bash.merge."));

  it.each([["gh $X"], ["gh pr $X 5"], ['gh "$X" 5'], ["gh $X merge 5"]])("reads %s as a merge of an unknown PR", (command) => {
    expect(merges(command).map((a) => [a.spelling, a.subject])).toEqual([["bash.merge.gh-pr-merge", {}]]);
  });

  it("reads a run-time verb behind a dynamic command word as a gh merge", () => {
    expect(spellings(merges('"$G" pr $X 5'))).toContain("bash.merge.gh-pr-merge");
  });

  it("keeps the PR a literal gh pr merge names", () => {
    expect(merges("gh pr merge 12 --squash").map((a) => a.subject)).toEqual([{ pr: "12" }]);
  });

  it("reads it as a switch to an unknown head, so a later push counts as protected", () => {
    expect(spellings(bash("gh $X 5 && git push", "feat/x"))).toContain("bash.merge.git-push-implicit");
    expect(merges("gh $X 5 && git push").at(-1)?.subject).toEqual({ branch: "unknown" });
  });

  it.each([["gh pr view $N"], ['gh --repo "$R" pr view 1'], ["gh pr view 1 && git push"]])("still allows %s", (command) => {
    expect(bash(command)).toEqual([]);
  });
});

describe("xargs runs gh with a word from its input", () => {
  it("denies every gh action when {} is the value of gh -R and the line has a space", () => {
    expect(spellings(bash("printf 'my repo' | xargs -I{} gh -R {} pr merge 1"))).toEqual([
      "bash.merge.gh-pr-merge",
      "bash.merge.gh-pr-merge",
      "bash.release.gh-release",
      "bash.egress.gh-gist",
    ]);
  });

  it("denies every gh action behind a stdin file", () => {
    expect(spellings(bash("xargs -I{} gh {} < cmds.txt"))).toEqual([
      "bash.merge.gh-pr-merge",
      "bash.release.gh-release",
      "bash.egress.gh-gist",
      "bash.merge.gh-pr-merge",
    ]);
  });
});
