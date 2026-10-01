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

describe("one fixture per bash.merge spelling", () => {
  it.each([
    ["bash.merge.gh-pr-merge", "gh pr merge 12 --squash", { pr: "12" }],
    ["bash.merge.gh-pr-merge", "gh pr merge --admin -d https://github.com/o/r/pull/7", { pr: "7" }],
    ["bash.merge.gh-pr-merge", "gh pr merge --auto --rebase", {}],
    ["bash.merge.gh-api-merge", "gh api -X PUT repos/o/r/pulls/12/merge -f merge_method=squash", { pr: "12" }],
    ["bash.merge.gh-api-merge", "gh api repos/o/r/pulls/12/merge --method=PUT", { pr: "12" }],
    ["bash.merge.gh-api-merge", "gh api repos/{owner}/{repo}/pulls/12/merge -f sha=abc", { pr: "12" }],
    ["bash.merge.gh-api-merges", "gh api -X POST repos/o/r/merges -f base=main -f head=feat", {}],
    ["bash.merge.gh-api-graphql", "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'", {}],
    ["bash.merge.gh-api-graphql", "gh api graphql --raw-field query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'", {}],
    ["bash.merge.curl-api", "curl -X PUT -H 'Accept: application/json' https://api.github.com/repos/o/r/pulls/3/merge", { pr: "3" }],
    ["bash.merge.curl-api", "wget --method=POST https://api.github.com/repos/o/r/merges", {}],
    ["bash.merge.git-push-protected", "git push origin HEAD:main", { branch: "main" }],
    ["bash.merge.git-push-protected", "git push origin +refs/heads/master", { branch: "master" }],
    ["bash.merge.git-push-protected", "git push origin feat:release/2.0", { branch: "release/2.0" }],
    ["bash.merge.git-push-protected", "git push origin --delete main", { branch: "main" }],
    ["bash.merge.git-push-protected", 'git push origin "$X":main', { branch: "main" }],
    ["bash.merge.git-push-protected", 'git push origin "${B}:main"', { branch: "main" }],
    ["bash.merge.git-push-protected", 'git push origin +"$X":main', { branch: "main" }],
    ["bash.merge.git-push-all", "git push --all origin", {}],
    ["bash.merge.git-push-all", "git push --mirror origin", {}],
    ["bash.merge.git-push-all", "git push origin 'refs/heads/*:refs/heads/*'", {}],
  ])("%s: %s", (spelling, command, subject) => {
    expect(bash(command)).toEqual([expect.objectContaining({ action: "merge", spelling, subject })]);
  });

  it("bash.merge.git-merge-protected: git merge of a feature branch while main is checked out", () => {
    expect(bash("git merge --no-ff feat/x -m 'merge'", "main")).toEqual([
      expect.objectContaining({ action: "merge", spelling: "bash.merge.git-merge-protected", subject: { branch: "main" } }),
    ]);
  });

  it("bash.merge.git-push-implicit: git push with no refspec while on main", () => {
    expect(spellings(bash("git push", "main"))).toEqual(["bash.merge.git-push-implicit"]);
    expect(spellings(bash("git push origin", "release/1.4"))).toEqual(["bash.merge.git-push-implicit"]);
  });

  it("bash.merge.git-push-protected: git push origin HEAD while on master", () => {
    expect(bash("git push -u origin HEAD", "master")).toEqual([expect.objectContaining({ subject: { branch: "master" } })]);
  });

  it("reads the head of the directory git -C names, and treats a directory it cannot know as protected", () => {
    expect(bash("git -C /elsewhere push", "main")).toEqual([]);
    expect(spellings(bash('cd "$(mktemp -d)" && git push'))).toEqual(["bash.merge.git-push-implicit"]);
  });

  it.each([
    ["&&", "git checkout main && git merge feat", ["bash.merge.git-merge-protected"]],
    ["; and &&", "git switch main; git merge feat && git push", ["bash.merge.git-merge-protected", "bash.merge.git-push-implicit"]],
    ["||", "git checkout release/2.0 || true\ngit push", ["bash.merge.git-push-implicit"]],
    ["gh pr checkout", "gh pr checkout 12 && git push", ["bash.merge.git-push-implicit"]],
  ])("an earlier branch switch on the line (%s) makes the head unknown, so later commands count as protected", (_sep, command, expected) => {
    expect(spellings(bash(command, "feat/x"))).toEqual(expected);
  });

  it.each([
    ["; ", "git checkout -b feat/z; git merge x"],
    ["&&", "git checkout -b feat/z && git merge x"],
  ])("a branch created from main (%s) leaves the head unknown, since a failed -b stays on main", (_sep, command) => {
    expect(spellings(bash(command, "main"))).toEqual(["bash.merge.git-merge-protected"]);
  });

  describe("a branch switch changes the head only in its own directory", () => {
    const MAIN_TREE = "/home/you/projects/app-main";
    const heads: Record<string, string> = { [REPO]: "feat/x", [MAIN_TREE]: "main" };
    const ctx: ClassifyContext = { home: HOME, readLink: () => null, readHead: (d) => heads[d] ?? null, readScript: () => null };
    const run = (command: string) => spellings(classify({ kind: "bash", command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null }, ctx));

    it("keeps another checkout's protected head after a switch here", () => {
      expect(run(`git checkout -b feat/z && git -C ${MAIN_TREE} merge x`)).toEqual(["bash.merge.git-merge-protected"]);
    });

    it("leaves this directory's protected head after a switch elsewhere", () => {
      expect(run(`cd ${MAIN_TREE} && git -C /elsewhere checkout -b f; git merge x`)).toEqual(["bash.merge.git-merge-protected"]);
    });

    it("marks every directory unknown after a switch in a directory it cannot know", () => {
      expect(run('git -C "$D" checkout -b f; git merge x')).toEqual(["bash.merge.git-merge-protected"]);
    });
  });

  it("finds a merge chained after other commands and inside a subshell", () => {
    expect(spellings(bash("pnpm test && (gh pr merge 4 --squash)"))).toEqual(["bash.merge.gh-pr-merge"]);
  });
});

describe("normal work classifies nothing", () => {
  it.each([
    ["git merge origin/main on main", "git merge origin/main", "main"],
    ["git merge --ff-only @{u} on main", "git merge --ff-only @{u}", "main"],
    ["git merge of main into a feature branch", "git merge --no-ff origin/main", "feat/x"],
    ["git merge --abort on main", "git merge --abort", "main"],
    ["git pull on main", "git pull --rebase origin main", "main"],
    ["git push of a feature branch", "git push origin feat/x", "main"],
    ["git push -u origin HEAD on a feature branch", "git push -u origin HEAD", "feat/x"],
    ["git push with no refspec on a feature branch", "git push", "feat/x"],
    ["git push on a detached head", "git push", null],
    ["git push of a branch named at run time", 'git push origin "$BRANCH"', "main"],
    ["git push --tags on main", "git push origin --tags", "main"],
    ["gh pr merge --disable-auto", "gh pr merge 12 --disable-auto", "feat/x"],
    ["gh pr view and gh pr create", "gh pr view 12 && gh pr create --base main --fill", "feat/x"],
    ["a GET of a PR's merge status", "gh api repos/o/r/pulls/12/merge", "feat/x"],
    ["a GET of PR checks", "gh api repos/o/r/commits/abc/check-runs --jq '.check_runs[].name'", "feat/x"],
    ["a graphql query that reads merge state", "gh api graphql -f query='{ repository(owner: \"o\", name: \"r\") { pullRequest(number: 1) { mergeable } } }'", "feat/x"],
    ["a curl GET of the merge endpoint", "curl https://api.github.com/repos/o/r/pulls/3/merge", "feat/x"],
    ["a commit message that mentions a merge", "git commit -m 'gh pr merge 12 after review'", "main"],
    ["a push after creating a branch from a feature branch", "git checkout -b feat/y && git push -u origin HEAD", "feat/x"],
    ["a push after git switch -c from a feature branch", "git switch -c feat/y origin/main; git push", "feat/x"],
    ["a path restore before a push", "git checkout -- src/a.ts && git push", "feat/x"],
    ["a push of a run-time branch name", 'git push origin "$X"', "main"],
  ])("%s", (_what, command, head) => {
    expect(bash(command, head)).toEqual([]);
  });
});
