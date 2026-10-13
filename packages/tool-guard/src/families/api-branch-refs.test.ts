import { describe, expect, it } from "vitest";
import { tokenize } from "../shell/lexer.js";
import type { WordToken } from "../shell/lexer.js";
import { apiBranchRefWrite } from "./api-branch-refs.js";

/** The words of a `gh api` field list as the lexer reads them, e.g. `ref="refs/heads/$B" sha=x`. */
function fields(src: string): WordToken[] {
  return tokenize(src).filter((t): t is WordToken => t.type === "word");
}

describe("a write to a branch ref by URL names the branch", () => {
  it.each([
    ["PATCH", "repos/o/r/git/refs/heads/main", "main"],
    ["DELETE", "repos/o/r/git/refs/heads/main", "main"],
    ["PATCH", "repos/o/r/git/refs/heads/release/2.0", "release/2.0"],
    ["PUT", "repos/o/r/git/ref/heads/main", "main"],
    ["PATCH", "https://api.github.com/repos/o/r/git/refs/heads/main", "main"],
    ["PATCH", "https://ghe.example.com/api/v3/repos/o/r/git/refs/heads/main", "main"],
    ["PATCH", "repos/o/r/git/refs/heads%2Fmain", "main"],
    ["PATCH", "repos/o/r/git//refs/heads/main", "main"],
    ["PATCH", "repos/o/r/GIT/Refs/HEADS/Main?force=true", "Main"],
    ["patch", "/repos/o/r/git/refs/heads/main/", "main"],
    [null, "repos/o/r/git/refs/heads/main", "main"],
    ["PATCH", "repos/o/r/git/refs/heads/feat/x?x={branch}", "feat/x"],
    ["DELETE", "repos/o/r/git/refs/heads/agent-chat/x", "agent-chat/x"],
  ])("%s %s names %s", (method, url, branch) => {
    expect(apiBranchRefWrite(url, method, [])).toEqual({ branches: [branch] });
  });

  it("reads a git refs path that cannot be percent-decoded as a branch known only at run time", () => {
    expect(apiBranchRefWrite("repos/o/r/git/refs/heads/%E0%A4", "PATCH", [])).toEqual({ branches: [null] });
  });

  it("reads an undecodable path whose git refs route is itself escaped as a branch known only at run time", () => {
    expect(apiBranchRefWrite("repos/o/r/%67it/refs/heads/%E0", "PATCH", [])).toEqual({ branches: [null] });
  });

  it("ignores a path that cannot be percent-decoded on another route", () => {
    expect(apiBranchRefWrite("repos/o/r/issues/%E0%A4", "PATCH", [])).toBeNull();
  });
});

describe("a write path with dot segments, which curl resolves, names a branch known only at run time", () => {
  it.each([
    "repos/o/r/git/refs/heads/feat/../main",
    "https://api.github.com/repos/o/r/git/refs/heads/feat/../main",
    "repos/o/r/git/refs/heads/./main",
    "repos/o/r/git/refs/heads/x/%2E%2E/main",
    "repos/o/r/git/x/../refs/heads/main",
    "repos/o/r/issues/../git/refs/heads/main",
    "repos/o/r/%67it/refs/heads/%E0/../main",
    "repos/o/r/%E0/../%67it/refs/heads/main",
    "repos/o/r/gi%74/refs/heads/%zz/../main",
    "repos/o/r/issues/../pulls/1",
  ])("PATCH %s", (url) => {
    expect(apiBranchRefWrite(url, "PATCH", [])).toEqual({ branches: [null] });
  });

  it("still lets a read through", () => {
    expect(apiBranchRefWrite("repos/o/r/git/refs/heads/feat/../main", "GET", [])).toBeNull();
  });
});

describe("a POST to git/refs reads its ref field", () => {
  it.each([
    ["ref=refs/heads/main sha=x", ["main"]],
    ["ref=heads/main sha=x", ["main"]],
    ["ref=refs/heads/feat/x sha=y", ["feat/x"]],
    ["ref[]=refs/heads/main", ["main"]],
    ['ref="refs/heads/$B" sha=x', [null]],
    ["ref=$(cat ref.txt) sha=x", [null]],
    ['"$K"=refs/heads/main sha=x', [null]],
    ["ref=@ref.txt", [null]],
    ["ref=refs/heads/feat/x ref=refs/heads/main", ["feat/x", "main"]],
    ["ref=refs/tags/v1 ref=refs/heads/main", ["main"]],
  ])("%s names %j", (src, branches) => {
    expect(apiBranchRefWrite("repos/o/r/git/refs", "POST", fields(src))).toEqual({ branches });
  });

  it("reads an unread --input body as a branch known only at run time", () => {
    expect(apiBranchRefWrite("repos/o/r/git/refs", "POST", "unread")).toEqual({ branches: [null] });
  });

  it("reads the fields when no method is given", () => {
    expect(apiBranchRefWrite("repos/o/r/git/refs", null, fields("ref=refs/heads/main"))).toEqual({ branches: ["main"] });
  });
});

describe("gh's run-time {branch} placeholder names an unknown branch", () => {
  it.each([
    ["PATCH", "repos/{owner}/{repo}/git/refs/heads/{branch}", ""],
    ["DELETE", "repos/:owner/:repo/git/refs/heads/:branch", ""],
    ["POST", "repos/o/r/git/refs", "ref=refs/heads/{branch} sha=x"],
    ["PATCH", "repos/o/r/git/refs/heads/m:branch", ""],
    ["POST", "repos/o/r/git/refs", "ref=refs/heads/m:branch sha=x"],
    ["PATCH", "repos/o/r/git/refs/heads/{owner}", ""],
    ["DELETE", "repos/o/r/git/refs/heads/ma:repo", ""],
    ["PATCH", "{owner}/o/r/git/refs/heads/main", ""],
    ["PATCH", ":owner/o/r/git/refs/heads/main", ""],
    ["PATCH", "repos/o/r/git/refs/{branch}", ""],
    ["PATCH", "repos/o/r/git/{branch}", ""],
    ["PATCH", "repos/o/r/{branch}", ""],
    ["PATCH", "repos/o/r/g{branch}", ""],
    ["PATCH", "repos/o/r/%67it/{branch}", ""],
    ["PATCH", "repos/o/r/git/refs/heads/feat-{branch}", ""],
    ["PATCH", "repos/o/r/{repo}/refs/heads/main", ""],
    ["PATCH", "repos/{owner}/{repo}/heads/main", "sha=x"],
    ["DELETE", "repos/o/:repo/x", ""],
    ["PUT", "repos/{owner}/r/issues/1", ""],
    ["POST", "repos/{owner}/{repo}/issues", "ref=refs/heads/{branch}"],
  ])("%s %s %s", (method, url, src) => {
    expect(apiBranchRefWrite(url, method, fields(src))).toEqual({ branches: [null] });
  });
});

describe("a placeholder in a ref field reads as unknown unless the text before it pins a non-heads ref", () => {
  it.each([
    ["ref=refs/{branch} sha=x", [null]],
    ["ref=refs/he{branch} sha=x", [null]],
    ["ref=refs/heads{branch} sha=x", [null]],
    ["ref=refs/:branch sha=x", [null]],
    ["ref={branch} sha=x", [null]],
    ["ref=re{branch} sha=x", [null]],
    ["ref=refs/heads/feat-{branch} sha=x", [null]],
    ["ref=refs/tags/{branch} ref=refs/heads/main", ["main"]],
    ["ref=refs/notes{branch} ref=refs/heads/main", ["main"]],
  ])("POST git/refs %s names %j", (src, branches) => {
    expect(apiBranchRefWrite("repos/o/r/git/refs", "POST", fields(src))).toEqual({ branches });
  });

  it("drops a tags ref with a placeholder when no other field names a head", () => {
    expect(apiBranchRefWrite("repos/o/r/git/refs", "POST", fields("ref=refs/tags/{branch} sha=x"))).toBeNull();
  });
});

describe("a filled repo slot holds through every early return of the path reading", () => {
  it.each([
    ["PATCH", "repos/{owner}/{repo}/x/%E0", "", "undecodable path"],
    ["DELETE", "repos/{owner}/{repo}/x/.", "", "unsure path"],
    ["PATCH", "repos/{owner}/{repo}/pulls/1", "", "no git refs route"],
    ["PATCH", "repos/{owner}/{repo}/git/refs", "", "git refs root, not POST"],
    ["POST", "repos/{owner}/{repo}/issues?ref=refs/heads/main", "", "POST, ref in the query"],
    ["PATCH", "repos/{owner}/{repo}/git/refs/tags/v1", "", "not a head"],
    ["POST", "repos/{owner}/{repo}/git/refs", "sha=x", "git refs root, POST with no ref"],
  ])("%s %s %s (%s)", (method, url, src) => {
    expect(apiBranchRefWrite(url, method, fields(src))).toEqual({ branches: [null] });
  });

  it.each([
    ["PATCH", "/repos/{owner}/{repo}/git/refs/heads/main/", "", ["main", null]],
    ["POST", "repos/{owner}/{repo}/git/refs/heads/feat/x", "sha=x", ["feat/x", null]],
    ["POST", "repos/{owner}/{repo}/git/refs/heads/main", "ref=refs/heads/feat sha=x force=true", ["main", "feat", null]],
    ["POST", "repos/{owner}/{repo}/git/refs", "ref=refs/heads/main sha=x", ["main", null]],
  ])("%s %s %s names the path and ref-field branches beside the unknown route", (method, url, src, branches) => {
    expect(apiBranchRefWrite(url, method, fields(src))).toEqual({ branches });
  });
});

describe("a filled repo slot passes only an allowlisted POST", () => {
  it.each([
    ["repos/{owner}/{repo}/issues", "title=x body=@b.md labels[]=bug assignees[]=me"],
    ["repos/{owner}/{repo}/issues/12/comments", "body=x"],
    ["repos/{owner}/{repo}/pulls", "title=x head=feat/x base=main body=y draft=true"],
    ["repos/{owner}/{repo}/pulls/12/comments", "body=x commit_id=c path=p line=1 side=RIGHT"],
    ["repos/:owner/:repo/pulls/12/reviews", "body=x event=APPROVE comments[][path]=p"],
    ["repos/{owner}/{repo}/labels", "name=bug color=f00 description=d"],
  ])("POST %s %s", (url, src) => {
    expect(apiBranchRefWrite(url, "POST", fields(src))).toBeNull();
  });

  it("lets gh's GET (no method, no fields) through", () => {
    expect(apiBranchRefWrite("repos/{owner}/{repo}/branches", null, [])).toBeNull();
  });

  it.each([
    ["POST", "repos/{owner}/{repo}/issues/12", "title=x"],
    ["POST", "repos/{owner}/{repo}/issues", "title=x state=open"],
    ["POST", "repos/{owner}/{repo}/issues?x=1", "title=x"],
    [null, "repos/{owner}/{repo}/labels", '"$K"=v'],
    ["POST", "repos/{owner}/{repo}/x", "required_approving_review_count=0"],
  ])("denies %s %s %s off the allowlist", (method, url, src) => {
    expect(apiBranchRefWrite(url, method, fields(src))).toEqual({ branches: [null] });
  });

  it("denies an unread --input body on an allowlisted tail", () => {
    expect(apiBranchRefWrite("repos/{owner}/{repo}/issues", "POST", "unread")).toEqual({ branches: [null] });
  });
});

describe("requests that move no branch ref", () => {
  it.each([
    ["POST", "repos/{owner}/{repo}/issues", "title=x"],
    [null, "repos/:owner/:repo/issues", "title=x body=y"],
    ["GET", "repos/o/r/git/refs/heads/main", ""],
    ["HEAD", "repos/o/r/git/refs/heads/main", ""],
    ["get", "repos/o/r/git/refs", "ref=refs/heads/main"],
    ["DELETE", "repos/o/r/git/refs/tags/v1", ""],
    ["POST", "repos/o/r/git/tags", "tag=v1"],
    ["POST", "repos/o/r/git/commits", "message=x"],
    ["POST", "repos/o/r/git/refs", "sha=x"],
    ["POST", "repos/o/r/git/refs", "ref=refs/tags/v1 sha=x"],
    ["PATCH", "repos/o/r/git/refs", "ref=refs/heads/main"],
    ["PATCH", "repos/o/r/git/refsfoo/heads/main", ""],
    ["PUT", "repos/o/r/pulls/12/merge", ""],
  ])("%s %s %s", (method, url, src) => {
    expect(apiBranchRefWrite(url, method, fields(src))).toBeNull();
  });
});
