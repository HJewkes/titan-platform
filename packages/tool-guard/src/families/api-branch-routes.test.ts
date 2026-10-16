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
    "/repos/o/r/CONTENTS/x?ref={branch}",
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
    ["POST", "repos/o/r/branches/{branch}/rename", "new_name=feat/y", "rename", [null]],
    ["POST", "repos/o/r/branches/feat/x/rename", "new_name={branch}", "rename", ["feat/x", null]],
    ["POST", "repos/o/r/merge-upstream", "branch={branch}", "merge-upstream", [null]],
    ["PATCH", "repos/o/r", "default_branch={branch}", "default-branch", [null]],
    ["DELETE", "repos/o/r/branches/m:branch/protection", "", "protection", [null]],
    ["DELETE", "repos/o/r/branches/:branch-1.0/protection", "", "protection", [null]],
    ["POST", "repos/o/r/branches/:branch.x/rename", "new_name=feat/y", "rename", [null]],
    ["PUT", "repos/o/r/contents/x", "branch=m:branch", "contents", [null]],
    ["DELETE", "repos/o/r/branches/{owner}/protection", "", "protection", [null]],
    ["DELETE", "repos/o/r/branches/ma:repo/protection", "", "protection", [null]],
    ["PUT", "repos/o/r/contents/x", "branch={owner}", "contents", [null]],
    ["POST", "repos/o/r/merge-upstream", "branch={repo}", "merge-upstream", [null]],
    ["POST", "repos/o/r/branches/feat/x/rename", "new_name={owner}", "rename", ["feat/x", null]],
    ["DELETE", "repos/o/r/branches/{branch}", "", "protection", [null]],
    ["DELETE", "repos/o/r/branches/:branch", "", "protection", [null]],
    ["POST", "repos/o/r/branches/x/{branch}", "", "protection", [null]],
    ["POST", "repos/o/r/branches/{branch}", "new_name=feat/y", "protection", [null]],
    ["PUT", "repos/o/r/{repo}", "branch=main", "contents", [null]],
    ["DELETE", "repos/o/{branch}", "", "contents", [null]],
    ["DELETE", "{owner}/o/r/branches/main/protection", "", "protection", [null]],
    ["DELETE", ":owner/o/r/branches/main/protection", "", "protection", [null]],
    ["DELETE", "re{repo}/o/r/branches/main/protection", "", "protection", [null]],
    ["PUT", "{owner}/o/r/contents/f", "branch=main", "contents", [null]],
    ["PATCH", "{owner}/o/r", "default_branch=main", "default-branch", [null]],
    ["POST", "{branch}", "", "contents", [null]],
    ["PATCH", "repos/{owner}/{repo}/issues/1", "default_branch=x", "default-branch", [null]],
    ["PATCH", "repos/:owner/:repo/pulls/1", "title=x", "default-branch", [null]],
    ["DELETE", "repos/{owner}/{repo}/protection", "", "protection", [null]],
    ["PUT", "repos/{owner}/{repo}/f", "message=m", "contents", [null]],
    ["PUT", "/repos/{owner}/{repo}/CONTENTS/x", "branch=feat/x", "contents", [null]],
    ["POST", "repos/{owner}/:repo/issues", "branch=main", "merge-upstream", [null]],
    ["POST", "repos/o/{repo}/x", "new_name=y", "merge-upstream", [null]],
    [null, "repos/{owner}/{repo}/issues", '"$K"=v', "merge-upstream", [null]],
    ["POST", "repos/{owner}/{repo}/users", "users[]=bot", "merge-upstream", [null]],
    ["POST", "repos/{owner}/{repo}/teams", "teams[]=t", "merge-upstream", [null]],
    ["POST", "repos/{owner}/{repo}/apps", "apps[]=a", "merge-upstream", [null]],
    [null, "repos/:owner/:repo/users", "users[]=bot", "merge-upstream", [null]],
    ["POST", "repos/{owner}/{repo}/contexts", "contexts[]=ci", "merge-upstream", [null]],
    ["POST", "repos/{owner}/{repo}/merges", "", "merge-upstream", [null]],
    ["POST", "repos/{owner}/{repo}", "base=main head=feat/x", "merge-upstream", [null]],
    [null, "repos/{owner}/{repo}/pulls/1/merge/", "merge_method=squash", "merge-upstream", [null]],
  ])("%s %s %s reads as %s %j", (method, url, src, route, branches) => {
    expect(apiBranchRouteWrite(url, method, fields(src))).toEqual({ route, branches });
  });

  it("reads an unread --input POST on a filled repo slot as unknown", () => {
    expect(apiBranchRouteWrite("repos/{owner}/{repo}/issues", "POST", "unread")).toEqual({ route: "merge-upstream", branches: [null] });
  });

  it("reads a merge-upstream branch outside refs/heads as unknown", () => {
    expect(apiBranchRouteWrite("repos/o/r/merge-upstream", "POST", fields("branch=refs/tags/x"))).toEqual({
      route: "merge-upstream",
      branches: [null],
    });
  });
});

describe("a filled repo slot holds through every early return of the path reading", () => {
  it.each([
    ["DELETE", "repos/{owner}/{repo}/x/%E0", "", "protection", "undecodable path"],
    ["DELETE", "repos/{owner}/{repo}/x/.", "", "protection", "unsure path, no guess"],
    ["PUT", "repos/{owner}/{repo}/x/.", "message=m", "contents", "unsure path, no guess"],
    ["POST", "repos/{owner}/{repo}/x/.", "users[]=bot", "merge-upstream", "unsure path, no guess"],
    ["POST", "repos/{owner}/{repo}/./merges", "base=main head=x", "merge-upstream", "unsure path, no guess"],
    ["PATCH", "repos/{owner}/{repo}/x/..", "title=x", "default-branch", "unsure path, no default_branch"],
    ["DELETE", "repos/{owner}/{repo}/branches/main/protection/.", "", "protection", "unsure path, guessed"],
    ["PUT", "repos/{owner}/{repo}", "title=x", "contents", "repository tail, not PATCH"],
    ["POST", "repos/{owner}/{repo}/merge-upstream", "", "merge-upstream", "merge-upstream without branch"],
    ["DELETE", "repos/{owner}/{repo}/branches/main", "", "protection", "branches tail, no route"],
    ["POST", "repos/{owner}/{repo}/users?users[]=bot", "", "merge-upstream", "other tail, key in the query"],
    ["POST", "repos/{owner}/{repo}/users?users%5B%5D=bot", "", "merge-upstream", "other tail, encoded query key"],
    ["POST", "repos/:owner/:repo/x?base=main&head=x", "", "merge-upstream", "other tail, merge keys in the query"],
    ["POST", "repos/{owner}/{repo}/issues?labels=x", "title=x", "merge-upstream", "allowlisted tail with a query"],
    ["POST", "repos/{owner}/{repo}/x/.", "title=x", "merge-upstream", "unsure path, no route key"],
  ])("%s %s %s reads as %s (%s)", (method, url, src, route, _returnPath) => {
    expect(apiBranchRouteWrite(url, method, fields(src))).toEqual({ route, branches: [null] });
  });

  it.each([
    ["GET", "repos/{owner}/{repo}/x/.", ""],
  ])("%s %s %s still passes", (method, url, src) => {
    expect(apiBranchRouteWrite(url, method, fields(src))).toBeNull();
  });
});

describe("a filled repo slot passes only an allowlisted POST", () => {
  it.each([
    ["repos/{owner}/{repo}/issues", "title=x body=@b.md labels[]=bug assignees[]=me"],
    ["repos/{owner}/{repo}/issues/12/comments", "body=x"],
    ["repos/{owner}/{repo}/pulls/12/comments", "body=x commit_id=c path=p line=1 side=RIGHT"],
    ["repos/:owner/:repo/pulls/12/reviews", "body=x event=APPROVE comments[][path]=p"],
    ["repos/{owner}/{repo}/labels", "name=bug color=f00 description=d"],
  ])("POST %s %s", (url, src) => {
    expect(apiBranchRouteWrite(url, "POST", fields(src))).toBeNull();
  });

  it("lets gh's GET (no method, no fields) through", () => {
    expect(apiBranchRouteWrite("repos/{owner}/{repo}/branches", null, [])).toBeNull();
  });

  it.each([
    ["base=feat/x head=feat/y title=t", ["feat/x"]],
    ["base=main head=feat/x title=t", ["main"]],
    ['base="$B" head=feat/x', [null]],
    ["base[]=main head=feat/x title=t", ["main"]],
    ["base[x]=main head=feat/x", ["main"]],
    ["base[]=feat/x base[]=main head=y", ["feat/x", "main"]],
    ["base[a=b]=main head=feat/x", [null]],
  ])("names a pull request create's base, which a cut fill can merge into: %s", (src, branches) => {
    expect(apiBranchRouteWrite("repos/{owner}/{repo}/pulls", "POST", fields(src))).toEqual({ route: "merge-upstream", branches });
  });

  it.each([
    ["POST", "repos/:owner/:repo/pulls"],
    [null, "repos/{owner}/{repo}/pulls"],
  ])("reads a %s pull request create with no base as an unknown base: %s", (method, url) => {
    expect(apiBranchRouteWrite(url, method, fields("head=feat/x title=t"))).toEqual({ route: "merge-upstream", branches: [null] });
  });

  it("names no base for an allowlisted tail that takes none", () => {
    expect(apiBranchRouteWrite("repos/{owner}/{repo}/issues", "POST", fields("title=x"))).toBeNull();
  });

  it.each([
    ["POST", "repos/{owner}/{repo}/git/refs", "sha=x", "merge-upstream"],
    ["POST", "repos/{owner}/{repo}/issues/12", "title=x", "merge-upstream"],
    ["POST", "repos/{owner}/{repo}/issues", "title=x state=open", "merge-upstream"],
    ["POST", "repos/{owner}/{repo}/x", "required_approving_review_count=0", "merge-upstream"],
    ["POST", "repos/{owner}/{repo}/branches/main/protection/required_pull_request_reviews", "dismiss_stale_reviews=false", "protection"],
  ])("denies %s %s %s off the allowlist", (method, url, src, route) => {
    expect(apiBranchRouteWrite(url, method, fields(src))).toEqual({ route, branches: [null] });
  });
});

describe("GitHub routes a POST as a PATCH", () => {
  it.each([
    ["repos/o/r", "default_branch=x", ["x"]],
    ["repos/o/r/", "default_branch=main", ["main"]],
  ])("POST %s %s changes the default branch", (url, src, branches) => {
    expect(apiBranchRouteWrite(url, "POST", fields(src))).toEqual({ route: "default-branch", branches });
  });

  it("reads POST protection sub-routes as protection writes", () => {
    expect(apiBranchRouteWrite("repos/o/r/branches/main/protection/required_pull_request_reviews", "POST", fields("x=y"))).toEqual({
      route: "protection",
      branches: ["main"],
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
    ["GET", "repos/o/r/branches/{branch}/protection", ""],
    ["POST", "repos/{owner}/{repo}/issues", "title=x"],
    [null, "repos/:owner/:repo/issues/1/comments", "body=x"],
    ["GET", "repos/{owner}/{repo}/branches/main/protection", ""],
    ["PUT", "repos/o/r/pulls/1/merge?x={branch}", ""],
  ])("%s %s %s", (method, url, src) => {
    expect(apiBranchRouteWrite(url, method, fields(src))).toBeNull();
  });
});
