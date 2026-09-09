import { describe, expect, it } from "vitest";
import { commandCwd, parseGitIntent, parsePrCreateTitle, parseTaskId, parseTaskIntent, parseTaskIntents, realCommand } from "./bash-parse.js";

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

describe("parseTaskIntent", () => {
  it("reads done as a status", () => {
    expect(parseTaskIntent("active-work task done demo AW-23")).toEqual({ taskId: "AW-23", status: "done" });
    expect(parseTaskIntent("aw task done demo AW-23 2>&1 | tail -3")).toEqual({ taskId: "AW-23", status: "done" });
  });

  it("reads an explicit status edit, and only when the field is status", () => {
    expect(parseTaskIntent("active-work task edit demo AW-23 status blocked")).toEqual({ taskId: "AW-23", status: "blocked" });
    expect(parseTaskIntent("active-work task edit demo AW-23 notes done")).toEqual({ taskId: "AW-23", status: null });
    expect(parseTaskIntent("active-work task edit demo AW-23 title done")).toEqual({ taskId: "AW-23", status: null });
  });

  it("names the task but claims no status for a read", () => {
    expect(parseTaskIntent("active-work task list demo AW-23")).toEqual({ taskId: "AW-23", status: null });
    expect(parseTaskIntent("aw task show demo AW-23")).toEqual({ taskId: "AW-23", status: null });
  });

  it("ignores commands that are not active-work, or that name no task", () => {
    expect(parseTaskIntent("echo AW-23")).toBeNull();
    expect(parseTaskIntent("gh pr merge 12 AW-23")).toBeNull();
    expect(parseTaskIntent("active-work task add demo --title x")).toBeNull();
  });

  it("does not mistake the word done elsewhere in the line for a status", () => {
    expect(parseTaskIntent("active-work task list demo | grep done AW-23")).toBeNull();
  });

  it("finds the invocation at the tail of a compound chain, the dominant real shape", () => {
    const real =
      'cd ~/projects/titan-platform && gh pr merge 5 --squash 2>&1 | tail -1; git checkout -q main && cd "/Users/x/active-work/titan-platform" && active-work task done titan-platform TP-5';
    expect(parseTaskIntents(real)).toEqual([{ taskId: "TP-5", status: "done" }]);
  });

  it("returns every task a chain closes, not just the first", () => {
    expect(parseTaskIntents("active-work task done demo AW-1 && active-work task done demo AW-2")).toEqual([
      { taskId: "AW-1", status: "done" },
      { taskId: "AW-2", status: "done" },
    ]);
  });

  it("prefers the status-bearing mention when one chain both reads and closes a task", () => {
    expect(parseTaskIntents("active-work task list demo AW-1 && active-work task done demo AW-1")).toEqual([{ taskId: "AW-1", status: "done" }]);
    expect(parseTaskIntents("active-work task done demo AW-1 && active-work task list demo AW-1")).toEqual([{ taskId: "AW-1", status: "done" }]);
  });

  it("does not read a status across a command boundary", () => {
    expect(parseTaskIntents("active-work task edit demo AW-1 notes x; echo status done")).toEqual([{ taskId: "AW-1", status: null }]);
  });
});
