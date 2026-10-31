import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitIn, seedRepo, withHistory } from "@titan-design/test-kit/git";
import { afterEach, describe, expect, it } from "vitest";
import { localCloneGit } from "../review-pr/bundle.js";
import { cloneFacts } from "./clone-facts.js";
import type { CorpusV3Row } from "./select.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): { dir: string; base: string } {
  const dir = join(mkdtempSync(join(tmpdir(), "clone-facts-")), "repo");
  dirs.push(join(dir, ".."));
  seedRepo(dir, {});
  const [base = ""] = withHistory(dir, [{ message: "base", files }]);
  return { dir, base };
}

const rowAt = (base: string, merge: string): CorpusV3Row => ({
  case_id: "r#1",
  repo: "o/r",
  pr_number: 1,
  base_commit: base,
  merge_commit: merge,
  class: "local-fix",
  n_tasks: 1,
  task_ids: [],
  task: null,
  title: "t",
  brief_text: null,
  follow_up_fixes: [],
});

const headOf = (dir: string): string => gitIn(dir)("rev-parse", "HEAD");

describe("cloneFacts", () => {
  it("a package-lock repo is supported, a repo with neither lockfile is not", async () => {
    const npm = repoWith({ "package-lock.json": "{}\n" });
    const pnpm = repoWith({ "pnpm-lock.yaml": "lockfileVersion: 9\n" });
    const none = repoWith({ "yarn.lock": "\n" });
    const supported = async ({ dir, base }: { dir: string; base: string }) => cloneFacts(() => localCloneGit(dir)).hasSupportedLock(rowAt(base, base));

    expect([await supported(npm), await supported(pnpm), await supported(none)]).toEqual([true, true, false]);
  });

  it("a merge with two parents counts as two", async () => {
    const { dir, base } = repoWith({ "a.txt": "a\n" });
    const run = gitIn(dir);
    withHistory(dir, [{ message: "pr", branch: "pr", from: "main", files: { "b.txt": "b\n" } }]);
    run("checkout", "-q", "main");
    run("merge", "-q", "--no-ff", "-m", "Merge pr", "pr");
    const facts = cloneFacts(() => localCloneGit(dir));

    expect(await facts.mergeParents(rowAt(base, headOf(dir)))).toBe(2);
    expect(await facts.mergeParents(rowAt(base, run("rev-parse", "pr")))).toBe(1);
  });

  it("tests plus source, tests alone and no test are told apart", async () => {
    const { dir, base } = repoWith({ "src/a.ts": "export const a = 1;\n", "src/a.test.ts": "it('a', () => {});\n" });
    const facts = cloneFacts(() => localCloneGit(dir));
    const after = (files: Record<string, string>): string => {
      withHistory(dir, [{ message: "next", files }]);
      return headOf(dir);
    };
    const both = after({ "src/b.ts": "export const b = 1;\n", "src/b.test.ts": "it('b', () => {});\n" });
    const testsOnly = after({ "src/c.test.ts": "it('c', () => {});\n" });
    const sourceOnly = after({ "src/d.ts": "export const d = 1;\n" });

    expect(await facts.testChange(rowAt(base, both))).toBe("tests-and-source");
    expect(await facts.testChange(rowAt(both, testsOnly))).toBe("test-only");
    expect(await facts.testChange(rowAt(testsOnly, sourceOnly))).toBe("no-test-change");
  });
});
