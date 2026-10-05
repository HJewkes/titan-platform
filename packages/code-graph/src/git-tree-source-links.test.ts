import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitTreeSource } from "./git-tree-source.js";
import { readSnapshot, type Snapshot } from "./incremental.test-helpers.js";
import { indexPaths, type IndexOptions } from "./indexer.js";
import { isolatedGitEnv } from "./history/test-repo.js";
import { openCodeGraph } from "./store.js";

// HEAD~1: b calls into a, and a root dir named `..foo` holds a source file.
const FIRST: Record<string, string> = {
  "packages/a/src/index.ts": "export function alpha(): number {\n  return 1;\n}\n",
  "packages/b/src/main.ts": 'import { alpha } from "../../a/src/index.js";\nexport const value = alpha();\n',
  "..foo/x.ts": "export const x = 1;\n",
};
// What today's disk holds for packages/a once the tracked dir is swapped for a link.
const RELOCATED_A = "export function beta(): number {\n  return 2;\n}\n";

let dir: string;
let outside: string;
let checkoutAtFirst: Snapshot;

const git = (args: readonly string[]) =>
  execFileSync("git", [...args], { cwd: dir, encoding: "utf-8", env: isolatedGitEnv() }).trim();

async function writeAll(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
}

function commit(message: string): void {
  git(["add", "-A"]);
  git(["-c", "user.name=alice", "-c", "user.email=alice@example.com", "commit", "-q", "-m", message]);
}

async function indexSnapshot(options: Partial<IndexOptions> = {}): Promise<Snapshot> {
  const store = openCodeGraph(":memory:");
  try {
    const result = await indexPaths(store, { paths: [dir], incremental: false, detectRenames: false, computeChurn: false, ...options });
    return readSnapshot(store, result.snapshotId);
  } finally {
    store.close();
  }
}

/** Replace tracked packages/a with a symlink to `target`, holding different code, for the length of `body`. */
async function withPackageALinkedTo(target: string, body: () => Promise<void>): Promise<void> {
  const packageA = path.join(dir, "packages/a");
  const parked = path.join(outside, "parked-a");
  await fs.rename(packageA, parked);
  await fs.mkdir(path.join(target, "src"), { recursive: true });
  await fs.writeFile(path.join(target, "src/index.ts"), RELOCATED_A);
  await fs.symlink(target, packageA);
  try {
    await body();
  } finally {
    await fs.rm(packageA);
    await fs.rm(target, { recursive: true });
    await fs.rename(parked, packageA);
  }
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-git-tree-links-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-git-tree-outside-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  await writeAll(FIRST);
  commit("first");
  await writeAll({ "packages/b/src/main.ts": 'import { alpha } from "../../a/src/index.js";\nexport const value = alpha() + 1;\n' });
  commit("second");

  git(["checkout", "-q", "HEAD~1"]);
  checkoutAtFirst = await indexSnapshot();
  git(["checkout", "-q", "main"]);
}, 60_000);

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe("gitTreeSource where today's disk links over a tracked dir", () => {
  it("indexes a tracked root dir named ..foo, as a checkout does", async () => {
    const atRev = await indexSnapshot({ source: gitTreeSource(dir, "HEAD~1") });

    expect(checkoutAtFirst.nodes.some((n) => n.includes('"id":"..foo/x.ts"'))).toBe(true);
    expect(atRev).toEqual(checkoutAtFirst);
  });

  it("reads a tracked dir from the commit when it is now a symlink to another dir in the repo", async () => {
    await withPackageALinkedTo(path.join(dir, "packages/a2"), async () => {
      const atRev = await indexSnapshot({ source: gitTreeSource(dir, "HEAD~1") });

      expect(atRev).toEqual(checkoutAtFirst);
    });
  });

  it("reads a tracked dir from the commit when it is now a symlink out of the repo", async () => {
    await withPackageALinkedTo(path.join(outside, "elsewhere-a"), async () => {
      const atRev = await indexSnapshot({ source: gitTreeSource(dir, "HEAD~1") });

      expect(atRev.nodes.some((n) => n.includes("#beta"))).toBe(false);
      expect(atRev).toEqual(checkoutAtFirst);
    });
  });

  it("throws ts-morph's not-found error for the realpath of an absent path", () => {
    const host = gitTreeSource(dir, "HEAD~1").fileSystem;
    const absent = path.join(dir, "packages/a/src/absent.ts");

    expect(host.realpathSync(path.join(dir, "packages/a/src/index.ts"))).toBe(
      path.join(gitTreeSource(dir, "HEAD~1").revision!.repoRoot, "packages/a/src/index.ts"),
    );
    expect(() => host.realpathSync(absent)).toThrow(
      expect.objectContaining({ constructor: expect.objectContaining({ name: "FileNotFoundError" }) }),
    );
  });
});
