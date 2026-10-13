import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assessDiff, GIT_BIN, resolveBaseRef } from "./review-diff.js";
import type { RunResult, Runner } from "./runner.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "review-diff-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A git stand-in answering by subcommand; refs not in `refs` fail to resolve. */
function fakeGit(answers: { status?: RunResult; refs?: string[]; revList?: RunResult }): Runner {
  return (bin, args) => {
    expect(bin).toBe(GIT_BIN);
    if (args[0] === "status") return answers.status ?? { status: 0, stdout: "" };
    if (args[0] === "rev-parse") return { status: (answers.refs ?? []).some((ref) => args[3] === `${ref}^{commit}`) ? 0 : 1, stdout: "" };
    return answers.revList ?? { status: 0, stdout: "0\n" };
  };
}

describe("assessDiff", () => {
  it("finds nothing to review when the worktree is gone", () => {
    expect(assessDiff(join(dir, "missing"), fakeGit({}))).toEqual({ reviewable: false, reason: expect.stringContaining("no longer exists") });
  });

  it("reviews uncommitted changes", () => {
    expect(assessDiff(dir, fakeGit({ status: { status: 0, stdout: "?? new.txt\n" } })).reason).toBe("worktree has uncommitted changes");
  });

  it("reviews when no base ref resolves, rather than assuming there is no diff", () => {
    expect(assessDiff(dir, fakeGit({}))).toEqual({ reviewable: true, reason: expect.stringContaining("no base ref") });
  });

  it("skips review for a clean worktree level with main", () => {
    expect(assessDiff(dir, fakeGit({ refs: ["main"] }))).toEqual({ reviewable: false, reason: "clean worktree and no commits ahead of main" });
  });

  it("reviews commits ahead of the base", () => {
    expect(assessDiff(dir, fakeGit({ refs: ["main"], revList: { status: 0, stdout: "1\n" } }))).toEqual({
      reviewable: true,
      reason: "1 commit(s) ahead of main",
    });
  });

  it("reviews when rev-list fails", () => {
    expect(assessDiff(dir, fakeGit({ refs: ["main"], revList: { status: 128, stdout: "" } })).reviewable).toBe(true);
  });
});

describe("resolveBaseRef", () => {
  it("prefers origin/HEAD over a local main", () => {
    expect(resolveBaseRef(dir, fakeGit({ refs: ["main", "origin/HEAD"] }))).toBe("origin/HEAD");
  });
});
