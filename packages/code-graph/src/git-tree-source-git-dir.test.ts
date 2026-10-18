import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitTreeSource } from "./git-tree-source.js";
import { detectGitToplevel } from "./history/git.js";
import { daysAgo, isolatedGitEnv } from "./history/test-repo.js";
import { indexPaths } from "./indexer.js";
import { openCodeGraph } from "./store.js";

vi.setConfig({ testTimeout: 30_000 });

const git = (cwd: string, args: readonly string[]) =>
  execFileSync("git", [...args], { cwd, encoding: "utf-8", env: isolatedGitEnv(daysAgo(3)) }).trim();

async function writeAll(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
}

function commitAll(root: string, message: string): void {
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=agent-x", "-c", "user.email=agent-x@example.com", "commit", "-q", "-m", message]);
}

/** A two-commit repo at `workTree` whose git dir is moved to `gitDir`, leaving the work tree with no `.git`. */
async function detachedRepo(workTree: string, gitDir: string): Promise<void> {
  await fs.mkdir(workTree, { recursive: true });
  git(workTree, ["init", "-q", "-b", "main"]);
  git(workTree, ["config", "commit.gpgsign", "false"]);
  await writeAll(workTree, { "tsconfig.json": "{}", "src/a.ts": "export const A = 1;\n", "src/b.ts": "export const B = 2;\n" });
  commitAll(workTree, "first");
  await writeAll(workTree, { "src/later.ts": "export const later = 3;\n" });
  commitAll(workTree, "second");
  await fs.rename(path.join(workTree, ".git"), gitDir);
  execFileSync("git", ["--git-dir", gitDir, "config", "core.worktree", workTree], { env: isolatedGitEnv() });
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
    await fs.mkdir(outer);
    git(outer, ["init", "-q", "-b", "main"]);
    const workTree = path.join(outer, "wt");
    const gitDir = path.join(base, "store.git");
    await detachedRepo(workTree, gitDir);
    vi.stubEnv("GIT_DIR", gitDir);

    expect(detectGitToplevel(workTree)).toBe(outer);
  });
});
