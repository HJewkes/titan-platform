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

// A built workspace: b imports @x/a, which node_modules links to packages/a,
// whose types entry is a gitignored build output that no commit tracks.
const TRACKED: Record<string, string> = {
  ".gitignore": "node_modules\ndist\n",
  "packages/a/package.json": JSON.stringify({ name: "@x/a", type: "module", types: "dist/index.d.ts", main: "dist/index.js" }),
  "packages/a/src/index.ts": "export function hello(): string {\n  return 'hi';\n}\n",
  "packages/b/package.json": JSON.stringify({ name: "@x/b", type: "module", dependencies: { "@x/a": "workspace:*" } }),
  "packages/b/src/main.ts": 'import { hello } from "@x/a";\nexport const greeting = hello();\n',
};
const BUILT: Record<string, string> = {
  "packages/a/dist/index.d.ts": "export declare function hello(): string;\n",
  "packages/a/dist/index.js": "export function hello() {\n  return 'hi';\n}\n",
};
const SECOND: Record<string, string> = {
  "packages/b/src/main.ts": 'import { hello } from "@x/a";\nexport const greeting = hello();\nexport const loud = greeting.toUpperCase();\n',
  "packages/b/src/later.ts": 'import { hello } from "@x/a";\nexport const later = hello();\n',
};

let dir: string;
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

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-git-tree-ws-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  await writeAll({ ...TRACKED, ...BUILT });
  await fs.mkdir(path.join(dir, "node_modules", "@x"), { recursive: true });
  await fs.symlink(path.join("..", "..", "packages", "a"), path.join(dir, "node_modules", "@x", "a"));
  commit("first");
  await writeAll(SECOND);
  commit("second");

  git(["checkout", "-q", "HEAD~1"]);
  checkoutAtFirst = await indexSnapshot();
  git(["checkout", "-q", "main"]);
}, 60_000);

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("gitTreeSource in a built workspace", () => {
  it("indexes through a package whose types entry is untracked build output", async () => {
    await expect(indexSnapshot({ source: gitTreeSource(dir, "HEAD") })).resolves.toBeDefined();
  });

  it("gives HEAD~1 the same cross-package edges as a checkout of it", async () => {
    const atRev = await indexSnapshot({ source: gitTreeSource(dir, "HEAD~1") });

    const crossPackage = (s: Snapshot) => s.edges.filter((e) => e.includes('"srcId":"packages/b/') && e.includes("packages/a/"));
    expect(crossPackage(checkoutAtFirst).length).toBeGreaterThan(0);
    expect(crossPackage(atRev)).toEqual(crossPackage(checkoutAtFirst));
    expect(atRev).toEqual(checkoutAtFirst);
  });

  it("answers existence, reads and listings alike for tracked, built and absent paths", () => {
    const source = gitTreeSource(dir, "HEAD~1");
    const host = source.fileSystem;
    const built = path.join(dir, "packages/a/dist/index.d.ts");
    const later = path.join(dir, "packages/b/src/later.ts");

    expect(source.fileExists(built)).toBe(true);
    expect(host.readFileSync(built)).toBe(BUILT["packages/a/dist/index.d.ts"]);
    expect(host.readDirSync(path.join(dir, "packages/a")).map((e) => path.basename(e.name)).sort()).toEqual(
      ["dist", "package.json", "src"],
    );
    // On disk now, but not at HEAD~1: absent, with ts-morph's own not-found error.
    expect(source.fileExists(later)).toBe(false);
    expect(host.fileExistsSync(later)).toBe(false);
    expect(() => host.readFileSync(later)).toThrow(expect.objectContaining({ constructor: expect.objectContaining({ name: "FileNotFoundError" }) }));
  });
});
