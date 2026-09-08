import { describe, expect, it } from "vitest";
import { commandCwd, parseGitIntent, parsePrCreateTitle, parseTaskId, realCommand } from "./bash-parse.js";

describe("parseGitIntent", () => {
  it("captures a new branch with its start point, plus commit and push", () => {
    expect(parseGitIntent("git checkout -b feat/x main && git commit -m y && git push -u origin feat/x")).toEqual({
      setBranch: "feat/x",
      branchBase: "main",
      deletedBranch: null,
      mergedPr: null,
      commit: true,
      push: true,
    });
  });

  it("does not read a start point across a newline or from a heredoc", () => {
    expect(parseGitIntent("git checkout -b feat/x\ngit add -A")?.branchBase).toBeNull();
    expect(parseGitIntent("git checkout -b feat/x <<'EOF'\nmain\nEOF")?.branchBase).toBeNull();
  });

  it("reads gh pr create head and base, merges, and deletions", () => {
    expect(parseGitIntent("gh pr create --head feat/y --base develop --title t")).toMatchObject({ setBranch: "feat/y", branchBase: "develop" });
    expect(parseGitIntent("gh pr merge 42 --squash")?.mergedPr).toBe(42);
    expect(parseGitIntent("git branch -D old/thing")?.deletedBranch).toBe("old/thing");
    expect(parseGitIntent("ls -la")).toBeNull();
  });
});

describe("shell helpers", () => {
  it("strips leading cd prefixes and resolves the command's cwd", () => {
    expect(realCommand("cd /tmp && cd sub; aw task done x AW-1")).toBe("aw task done x AW-1");
    expect(commandCwd("cd /repo && git checkout -b x", "/elsewhere")).toBe("/repo");
    expect(commandCwd("git -C /other status", "/elsewhere")).toBe("/other");
    expect(commandCwd("git status", "/elsewhere")).toBe("/elsewhere");
  });

  it("extracts PR titles with shell unescaping and task ids only from aw commands", () => {
    expect(parsePrCreateTitle('gh pr create --title "Fix \\`thing\\`" --body x')).toBe("Fix `thing`");
    expect(parsePrCreateTitle("gh pr create --title 'raw \\ title'")).toBe("raw \\ title");
    expect(parseTaskId("aw task done demo AW-23")).toBe("AW-23");
    expect(parseTaskId("echo AW-23")).toBeNull();
  });
});
