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
    ["patch", "/repos/{owner}/{repo}/git/refs/heads/main/", "main"],
    [null, "repos/o/r/git/refs/heads/main", "main"],
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

describe("requests that move no branch ref", () => {
  it.each([
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
