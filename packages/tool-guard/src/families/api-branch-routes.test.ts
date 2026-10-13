import { describe, expect, it } from "vitest";
import { tokenize } from "../shell/lexer.js";
import type { WordToken } from "../shell/lexer.js";
import { apiBranchRouteWrite } from "./api-branch-routes.js";

/** The words of a `gh api` field list as the lexer reads them, e.g. `branch="$B" message=m`. */
function fields(src: string): WordToken[] {
  return tokenize(src).filter((t): t is WordToken => t.type === "word");
}

describe("a contents write names the branch it commits to", () => {
  it.each([
    ["PUT", "branch=main message=m", ["main"]],
    ["DELETE", "branch=main sha=x", ["main"]],
    ["PUT", "branch=refs/heads/main", ["main"]],
    ["PUT", 'branch="$B" message=m', [null]],
    ["PUT", "branch=@branch.txt", [null]],
    ["PUT", '"$K"=main message=m', [null]],
    ["PUT", "message=m content=eA==", [null]],
    ["DELETE", "message=m sha=x", [null]],
    ["POST", "message=m", [null]],
    [null, "message=m", [null]],
    ["PUT", "branch=feat/x message=m", ["feat/x"]],
  ])("%s with %s names %j", (method, src, branches) => {
    expect(apiBranchRouteWrite("repos/o/r/contents/README.md", method, fields(src))).toEqual({ route: "contents", branches });
  });

  it("reads an unread --input body as the default branch", () => {
    expect(apiBranchRouteWrite("repos/o/r/contents/a/b.md", "PUT", "unread")).toEqual({ route: "contents", branches: [null] });
  });

  it.each([
    "https://api.github.com/repos/o/r/contents/x",
    "https://ghe.example.com/api/v3/repos/o/r/contents/x",
    "/repos/{owner}/{repo}/CONTENTS/x?ref=y",
    "repos/o/r/contents",
  ])("matches %s", (url) => {
    expect(apiBranchRouteWrite(url, "PUT", fields("branch=main"))).toEqual({ route: "contents", branches: ["main"] });
  });
});

describe("merge-upstream names the fork branch it merges into", () => {
  it.each([
    ["branch=main", ["main"]],
    ['branch="$B"', [null]],
    ["branch=feat/x", ["feat/x"]],
  ])("%s names %j", (src, branches) => {
    expect(apiBranchRouteWrite("repos/o/r/merge-upstream", "POST", fields(src))).toEqual({ route: "merge-upstream", branches });
  });

  it("reads an unread --input body as a branch known only at run time", () => {
    expect(apiBranchRouteWrite("repos/o/r/merge-upstream", "POST", "unread")).toEqual({ route: "merge-upstream", branches: [null] });
  });

  it("moves nothing without a branch field, which GitHub rejects", () => {
    expect(apiBranchRouteWrite("repos/o/r/merge-upstream", "POST", fields("x=y"))).toBeNull();
  });
});

describe("a branch rename names the old and new branch", () => {
  it.each([
    ["repos/o/r/branches/main/rename", "new_name=feat/y", ["main", "feat/y"]],
    ["repos/o/r/branches/release/2.0/rename", "new_name=feat/y", ["release/2.0", "feat/y"]],
    ["repos/o/r/branches/feat/x/rename", "new_name=main", ["feat/x", "main"]],
    ["repos/o/r/branches/feat/x/rename", 'new_name="$N"', ["feat/x", null]],
    ["repos/o/r/branches/feat/x/rename", "new_name=feat/y", ["feat/x", "feat/y"]],
  ])("%s with %s names %j", (url, src, branches) => {
    expect(apiBranchRouteWrite(url, "POST", fields(src))).toEqual({ route: "rename", branches });
  });

  it("reads an unread --input body's new name as known only at run time", () => {
    expect(apiBranchRouteWrite("repos/o/r/branches/feat/x/rename", "POST", "unread")).toEqual({ route: "rename", branches: ["feat/x", null] });
  });
});

describe("a write on branch protection names every branch the path can name", () => {
  it.each([
    ["DELETE", "repos/o/r/branches/main/protection", ["main"]],
    ["DELETE", "repos/o/r/branches/main/protection/enforce_admins", ["main"]],
    ["DELETE", "repos/o/r/branches/main/protection/required_pull_request_reviews", ["main"]],
    ["PUT", "repos/o/r/branches/release/2.0/protection", ["release/2.0"]],
    ["DELETE", "repos/o/r/branches/ma%69n/protection", ["main"]],
    ["DELETE", "repos/o/r/branches/release%2F2.0/protection", ["release/2.0"]],
    ["DELETE", "repos/o/r/branches/main/protection/x/protection", ["main", "main/protection/x"]],
    ["POST", "repos/o/r/branches/a/rename/protection", ["a/rename"]],
    ["DELETE", "repos/o/r/branches/feat/x/protection", ["feat/x"]],
  ])("%s %s names %j", (method, url, branches) => {
    expect(apiBranchRouteWrite(url, method, [])).toEqual({ route: "protection", branches });
  });

  it("names both readings when a rename path also ends a protection route", () => {
    expect(apiBranchRouteWrite("repos/o/r/branches/main/protection/rename", "POST", [])).toEqual({
      route: "protection",
      branches: ["main", "main/protection"],
    });
  });
});

describe("a repository PATCH of default_branch names the new default", () => {
  it.each([
    ["default_branch=main", ["main"]],
    ["default_branch=feat/x", ["feat/x"]],
    ['default_branch="$B"', [null]],
    ['"$K"=main', [null]],
  ])("%s names %j", (src, branches) => {
    expect(apiBranchRouteWrite("repos/o/r", "PATCH", fields(src))).toEqual({ route: "default-branch", branches });
  });

  it.each([
    ["PATCH", "repos/o/r/", "unread"],
    [null, "https://api.github.com/repos/o/r", "unread"],
  ] as const)("%s %s with %s reads a run-time default", (method, url, body) => {
    expect(apiBranchRouteWrite(url, method, body)).toEqual({ route: "default-branch", branches: [null] });
  });
});

describe("a path with dot segments or no full decoding reads its loose route with a run-time branch", () => {
  it.each([
    ["repos/o/r/contents/../git/refs/heads/main", "contents"],
    ["repos/o/r/x/../branches/main/protection", "protection"],
    ["repos/o/r/branches/%E0/protection", "protection"],
    ["repos/o/r/branches/%E0/rename", "rename"],
    ["repos/o/r/%6Derge-upstream/%E0", "merge-upstream"],
  ])("PUT %s reads as %s", (url, route) => {
    expect(apiBranchRouteWrite(url, "PUT", fields("branch=feat/x"))).toEqual({ route, branches: [null] });
  });

  it("reads a PATCH of default_branch on an unsure repository path as a run-time default", () => {
    expect(apiBranchRouteWrite("repos/o/r/x/..", "PATCH", fields("default_branch=feat/x"))).toEqual({
      route: "default-branch",
      branches: [null],
    });
  });
});

describe("gh's run-time {branch} placeholder names an unknown branch", () => {
  it.each([
    ["DELETE", "repos/{owner}/{repo}/branches/{branch}/protection", "", "protection", [null]],
    ["DELETE", "repos/:owner/:repo/branches/:branch/protection/enforce_admins", "", "protection", [null]],
    ["PUT", "repos/o/r/contents/x", "branch={branch}", "contents", [null]],
    ["PUT", "repos/o/r/contents/x", "branch=refs/heads/{branch}", "contents", [null]],
    ["POST", "repos/o/r/branches/{branch}/rename", "new_name=feat/y", "rename", [null, "feat/y"]],
    ["POST", "repos/o/r/branches/feat/x/rename", "new_name={branch}", "rename", ["feat/x", null]],
    ["POST", "repos/o/r/merge-upstream", "branch={branch}", "merge-upstream", [null]],
    ["PATCH", "repos/o/r", "default_branch={branch}", "default-branch", [null]],
    ["DELETE", "repos/o/r/branches/m:branch/protection", "", "protection", [null]],
    ["DELETE", "repos/o/r/branches/:branch-1.0/protection", "", "protection", [null]],
    ["POST", "repos/o/r/branches/:branch.x/rename", "new_name=feat/y", "rename", [null, "feat/y"]],
    ["PUT", "repos/o/r/contents/x", "branch=m:branch", "contents", [null]],
  ])("%s %s %s reads as %s %j", (method, url, src, route, branches) => {
    expect(apiBranchRouteWrite(url, method, fields(src))).toEqual({ route, branches });
  });

  it("reads a merge-upstream branch outside refs/heads as unknown", () => {
    expect(apiBranchRouteWrite("repos/o/r/merge-upstream", "POST", fields("branch=refs/tags/x"))).toEqual({
      route: "merge-upstream",
      branches: [null],
    });
  });
});

describe("requests that change no branch", () => {
  it.each([
    ["GET", "repos/o/r/contents/README.md", "branch=main"],
    ["HEAD", "repos/o/r/contents/README.md", ""],
    ["GET", "repos/o/r/branches/main/rename", "new_name=main"],
    ["GET", "repos/o/r/merge-upstream", "branch=main"],
    ["GET", "repos/o/r/branches/main/protection", ""],
    ["head", "repos/o/r/branches/main/protection/enforce_admins", ""],
    ["GET", "repos/o/r", "default_branch=main"],
    ["GET", "repos/o/r/contents/../branches/main/protection", ""],
    ["PATCH", "repos/o/r", "description=x"],
    ["PUT", "repos/o/r", "default_branch=main"],
    ["PUT", "repos/o/r/contentsX/a", "branch=main"],
    ["DELETE", "repos/o/r/branches-foo/main/protection", ""],
    ["DELETE", "repos/o/r/branches/main", ""],
    ["POST", "repos/o/r/branches/rename", ""],
    ["DELETE", "repos/o/r/branches/protection", ""],
    ["PATCH", "repos/o/r/issues/%E0", ""],
    ["PATCH", "user/../x", "default_branch=main"],
    ["PATCH", "repos/o/r/issues/../pulls/1", "title=x"],
    ["PUT", "repos/o/r/pulls/12/merge", ""],
  ])("%s %s %s", (method, url, src) => {
    expect(apiBranchRouteWrite(url, method, fields(src))).toBeNull();
  });
});
