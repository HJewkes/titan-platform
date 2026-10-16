import { describe, expect, it } from "vitest";
import { planPathFor } from "./brief.js";
import { defaultBranch } from "./observe.js";
import { DEFAULT_NAME_PREFIX, agentNameFor, reviewerNameFor, successorNameFor } from "./plan.js";
import { githubRepoOf, jsonLines, originRepo } from "./pr-adopt-ports.js";
import { GIT_BIN } from "./review-diff.js";
import type { RunResult, Runner } from "./runner.js";
import { worktreePathFor } from "./trust-gate.js";

const answering =
  (result: RunResult, calls: string[][] = []): Runner =>
  (bin, args, cwd) => {
    calls.push([bin, ...args, `cwd=${cwd ?? ""}`]);
    return result;
  };

describe("agent names", () => {
  it("names a tick spawn by prefix, lower-cased task id and slice", () => {
    expect(agentNameFor("TP-12")).toBe(`${DEFAULT_NAME_PREFIX}-tp-12`);
    expect(agentNameFor("TP-12", "B", "sa")).toBe("sa-tp-12-b");
  });

  it("suffixes a successor with its attempt and a reviewer with its round", () => {
    expect(successorNameFor("TP-12", 2, "a")).toBe("bd-tp-12-a-s2");
    expect(reviewerNameFor("TP-12", 1, undefined, "sa")).toBe("sa-tp-12-r1");
  });
});

describe("paths", () => {
  it("puts a task's plan under its initiative's sources", () => {
    expect(planPathFor("/aw/init", "TP-12")).toBe("/aw/init/sources/TP-12-plan.md");
  });

  it("cuts a spawn's worktree under the repo's .worktrees", () => {
    expect(worktreePathFor("/repo", "bd-tp-12")).toBe("/repo/.worktrees/bd-tp-12");
  });
});

describe("defaultBranch", () => {
  it("reads origin/HEAD's branch through the pinned git", () => {
    const calls: string[][] = [];

    expect(defaultBranch("/repo", answering({ status: 0, stdout: "origin/trunk\n" }, calls))).toBe("trunk");
    expect(calls).toEqual([[GIT_BIN, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD", "cwd=/repo"]]);
  });

  it("falls back to main when the clone has no origin/HEAD", () => {
    expect(defaultBranch("/repo", answering({ status: 1, stdout: "" }))).toBe("main");
  });
});

describe("originRepo", () => {
  it.each([
    ["git@github.com:o/r.git\n", "o/r"],
    ["https://github.com/o/r\n", "o/r"],
    ["https://example.com/o/r.git\n", undefined],
  ])("reads %j as %j", (stdout, repo) => {
    expect(originRepo("/repo", answering({ status: 0, stdout }))).toBe(repo);
  });

  it("is undefined when git fails", () => {
    expect(originRepo("/repo", answering({ status: 2, stdout: "" }))).toBeUndefined();
    expect(githubRepoOf("not a url")).toBeUndefined();
  });
});

describe("jsonLines", () => {
  it("parses each non-blank line and reads a bad one as undefined", () => {
    expect(jsonLines('{"a":1}\n\nnot json\n2\n')).toEqual([{ a: 1 }, undefined, 2]);
  });
});
