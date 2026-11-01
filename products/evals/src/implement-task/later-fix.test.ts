import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnExec, type Exec } from "@titan-design/fix-proof";
import { gitIn, seedRepo, withHistory } from "@titan-design/test-kit/git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localCloneGit } from "../review-pr/bundle.js";
import { buildCorrectedRef, fixTests, indexCorpus, laterFixCandidates, type CorrectedRefInput, type LaterFixRow } from "./later-fix.js";

const REPO = "owner/widgets";

function rowOf(pr: number, overrides: Partial<LaterFixRow> = {}): LaterFixRow {
  return {
    case_id: `widgets-pr${pr}`,
    repo: REPO,
    pr_number: pr,
    base_commit: "a".repeat(40),
    merge_commit: "b".repeat(40),
    class: "local-fix",
    n_tasks: 1,
    task_ids: [],
    task: null,
    title: `PR ${pr}`,
    brief_text: null,
    follow_up_fixes: [],
    ...overrides,
  };
}

describe("laterFixCandidates", () => {
  it("keeps one candidate per fix PR, preferring follow-up, and rejects a fix the corpus lacks", () => {
    const index = indexCorpus([rowOf(3), rowOf(5), rowOf(7, { repo: "owner/other" })]);
    const row = rowOf(3, { follow_up_fixes: [5], fix_touch_14d: [5, 7, 3] });

    const { candidates, rejected } = laterFixCandidates(row, index);

    expect(candidates.map(({ pr, fixSource, row: fix }) => ({ pr, fixSource, case: fix.case_id }))).toEqual([{ pr: 5, fixSource: "follow-up", case: "widgets-pr5" }]);
    expect(rejected).toEqual([{ pr: 7, fixSource: "fix-touch", reason: "fix-not-in-corpus" }]);
  });

  it("reads a row with no file-overlap links as follow-ups only, in PR order", () => {
    const index = indexCorpus([rowOf(1), rowOf(9), rowOf(4)]);

    const { candidates } = laterFixCandidates(rowOf(1, { follow_up_fixes: [9, 4] }), index);

    expect(candidates.map((candidate) => candidate.pr)).toEqual([4, 9]);
  });
});

interface History {
  base: string;
  merge: string;
  intervening: string;
  fix: { base: string; merge: string };
  conflicting: { base: string; merge: string };
  /** Edits a line two away from one main changed after M: a three-way merge would take it, a plain apply does not. */
  nearby: { base: string; merge: string };
}

const listFile = (edits: Record<number, string> = {}): string => Array.from({ length: 9 }, (_, i) => `${edits[i + 1] ?? `line ${i + 1}`}\n`).join("");

function mergeBranch(run: (...args: string[]) => string, branch: string): { base: string; merge: string } {
  const base = run("rev-parse", "main");
  run("checkout", "-q", "main");
  run("merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch);
  return { base, merge: run("rev-parse", "HEAD") };
}

// Base B, accepted merge M adding x = 2, then main moves x and a list line before three fix PRs land.
function writeHistory(dir: string): History {
  seedRepo(dir, {});
  const run = gitIn(dir);
  const [base = ""] = withHistory(dir, [
    { message: "base", files: { "package.json": "{\"name\":\"w\"}\n", "src/a.ts": "export const a = 1;\n", "src/a.test.ts": "it('a', () => {});\n", "src/list.ts": listFile() } },
    { message: "pr", branch: "pr", from: "main", files: { "src/x.ts": "export const x = 2;\n" } },
  ]);
  const merge = mergeBranch(run, "pr").merge;
  const [intervening = ""] = withHistory(dir, [{ message: "x to 3", files: { "src/x.ts": "export const x = 3;\n", "src/list.ts": listFile({ 3: "line 3 moved" }) } }]);
  withHistory(dir, [
    {
      message: "fix a",
      branch: "fix",
      from: "main",
      files: { "package.json": "{\"name\":\"w\",\"private\":true}\n", "src/a.ts": "export const a = 10;\n", "src/bug.test.ts": "it('bug', () => {});\n", "src/fixtures/bug.json": "{}\n" },
    },
  ]);
  const fix = mergeBranch(run, "fix");
  withHistory(dir, [{ message: "fix x", branch: "fix-x", from: "main", files: { "src/x.ts": "export const x = 4;\n", "src/x.test.ts": "it('x', () => {});\n" } }]);
  const conflicting = mergeBranch(run, "fix-x");
  withHistory(dir, [{ message: "fix list", branch: "fix-list", from: "main", files: { "src/list.ts": listFile({ 3: "line 3 moved", 6: "line 6 fixed" }), "src/list.test.ts": "it('list', () => {});\n" } }]);
  const nearby = mergeBranch(run, "fix-list");
  return { base, merge, intervening, fix, conflicting, nearby };
}

describe("buildCorrectedRef and fixTests", () => {
  let root: string;
  let clone: string;
  let scratchDir: string;
  let history: History;
  const calls: string[][] = [];
  const recordingExec: Exec = (file, args, options) => {
    calls.push([file, ...args]);
    return spawnExec(file, args, options);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "later-fix-"));
    clone = join(root, "clone");
    scratchDir = join(root, "scratch");
    history = writeHistory(clone);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const inputFor = (fix: { base: string; merge: string }, overrides: Partial<CorrectedRefInput> = {}): CorrectedRefInput => ({
    clone,
    scratchDir,
    merge: history.merge,
    fixPr: 11,
    fixBase: fix.base,
    fixMerge: fix.merge,
    exec: recordingExec,
    ...overrides,
  });

  const run = (...args: string[]): string => gitIn(clone)(...args);
  const worktrees = (): string[] => run("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "));

  it("commits the fix's diff on the accepted merge, with M as parent and a stable sha", async () => {
    const first = await buildCorrectedRef(inputFor(history.fix));
    const second = await buildCorrectedRef(inputFor(history.fix));

    if (!first.ok) throw new Error(`expected a corrected ref, got ${first.reason}`);
    expect(second).toEqual(first);
    expect(run("rev-parse", `${first.sha}^1`)).toBe(history.merge);
    expect(run("rev-list", "--count", `${history.merge}..${first.sha}`)).toBe("1");
    expect(run("diff", "--name-status", history.merge, first.sha)).toBe(run("diff", "--name-status", history.fix.base, history.fix.merge));
    expect(run("show", `${first.sha}:src/x.ts`)).toBe("export const x = 2;");
    expect(run("show", `${first.sha}:package.json`)).toBe("{\"name\":\"w\",\"private\":true}");
    expect(worktrees()).toHaveLength(1);
    expect(readdirSync(scratchDir)).toEqual([]);
  });

  it("rejects a fix whose hunk does not apply to M, leaving no commit, worktree or patch", async () => {
    const before = run("for-each-ref");

    const result = await buildCorrectedRef(inputFor(history.conflicting));

    expect(result).toEqual({ ok: false, reason: "fix-not-applicable" });
    expect(run("for-each-ref")).toBe(before);
    expect(worktrees()).toHaveLength(1);
    expect(readdirSync(scratchDir)).toEqual([]);
  });

  it("rejects a fix a three-way merge would take but a plain apply does not", async () => {
    const result = await buildCorrectedRef(inputFor(history.nearby));

    expect(result).toEqual({ ok: false, reason: "fix-not-applicable" });
    expect(worktrees()).toHaveLength(1);
  });

  it("rejects a fix that is an ancestor of the accepted merge before making a worktree", async () => {
    const result = await buildCorrectedRef(inputFor({ base: history.base, merge: history.base }, { scratchDir: join(root, "unused") }));

    expect(result).toEqual({ ok: false, reason: "fix-not-descendant" });
    expect(existsSync(join(root, "unused"))).toBe(false);
  });

  it("runs only git in the scratch clone and its worktrees, never gh", () => {
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const gitArgs = call[0] === "env" ? call.slice(call.indexOf("git")) : call;
      expect(gitArgs[0]).toBe("git");
      expect(gitArgs[1]).toBe("-C");
      expect(gitArgs[2]?.startsWith(clone) || gitArgs[2]?.startsWith(scratchDir)).toBe(true);
    }
  });

  it("plans the fix's tests and keeps its fixtures as carried files", async () => {
    const planned = await fixTests(localCloneGit(clone), history.fix.base, history.fix.merge);

    expect(planned).toEqual({ ok: true, tests: ["src/bug.test.ts"], carried: ["src/fixtures/bug.json"] });
  });

  it("rejects a fix that changes no test", async () => {
    const planned = await fixTests(localCloneGit(clone), history.merge, history.intervening);

    expect(planned).toEqual({ ok: false, reason: "fix-no-tests" });
  });
});
