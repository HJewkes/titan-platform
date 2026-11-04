import { gitIn, seedRepo, withHistory } from "@titan-design/test-kit/git";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitTreeSource } from "./git-tree-source.js";
import { detectGitToplevel } from "./history/git.js";
import { daysAgo } from "./history/test-repo.js";
import { indexPaths } from "./indexer.js";
import { openCodeGraph } from "./store.js";

vi.setConfig({ testTimeout: 30_000 });

/** A two-commit repo at `workTree` whose git dir is moved to `gitDir`, leaving the work tree with no `.git`. */
async function detachedRepo(workTree: string, gitDir: string): Promise<void> {
  seedRepo(workTree, {});
  const commit = { author: "agent-x", date: daysAgo(3) };
  withHistory(workTree, [
    { ...commit, message: "first", files: { "tsconfig.json": "{}", "src/a.ts": "export const A = 1;\n", "src/b.ts": "export const B = 2;\n" } },
    { ...commit, message: "second", files: { "src/later.ts": "export const later = 3;\n" } },
  ]);
  await fs.rename(path.join(workTree, ".git"), gitDir);
  gitIn(path.dirname(gitDir))("--git-dir", gitDir, "config", "core.worktree", workTree);
}

async function indexAtRev(workTree: string, rev: string) {
  const store = openCodeGraph(":memory:");
  try {
    const result = await indexPaths(store, {
      paths: [workTree],
      tsConfig: path.join(workTree, "tsconfig.json"),
      incremental: false,
      detectRenames: false,
      source: gitTreeSource(workTree, rev),
    });
    const files = store.listNodes(result.snapshotId).filter((n) => n.kind === "file").map((n) => n.id);
    const metrics = new Set(store.listMetrics(result.snapshotId).map((m) => m.name));
    return { files: files.sort(), metrics };
  } finally {
    store.close();
  }
}

let base: string;

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-git-dir-")));
  vi.stubEnv("GIT_CEILING_DIRECTORIES", path.dirname(base));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(base, { recursive: true, force: true });
});

describe("a caller-set GIT_DIR", () => {
  it("indexes a revision of a work tree whose git dir lives outside it", async () => {
    const workTree = path.join(base, "wt");
    const gitDir = path.join(base, "store.git");
    await detachedRepo(workTree, gitDir);
    vi.stubEnv("GIT_DIR", gitDir);

    const atRev = await indexAtRev(workTree, "HEAD~1");

    expect(atRev.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(atRev.metrics.has("churn_30d")).toBe(true);
    expect(atRev.metrics.has("file_age_days")).toBe(true);
  });

  it("loses to the repo found from the work tree when it is nested inside another repo", async () => {
    const outer = path.join(base, "outer");
    seedRepo(outer, {});
    const workTree = path.join(outer, "wt");
    const gitDir = path.join(base, "store.git");
    await detachedRepo(workTree, gitDir);
    vi.stubEnv("GIT_DIR", gitDir);

    expect(detectGitToplevel(workTree)).toBe(outer);
  });
});
