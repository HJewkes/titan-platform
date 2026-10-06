import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
// b/src/links.ts also imports through two symlinks the commit tracks (LINKS).
const FIRST: Record<string, string> = {
  "packages/a/src/index.ts": "export function alpha(): number {\n  return 1;\n}\n",
  "packages/a/src/extra.ts": "export function extra(): number {\n  return 3;\n}\n",
  "packages/b/src/main.ts": 'import { alpha } from "../../a/src/index.js";\nexport const value = alpha();\n',
  "packages/b/src/links.ts":
    'import { gamma } from "../../../clink/src/index.js";\nimport { extra } from "./dlink.js";\nexport const v = gamma() + extra();\n',
  "packages/c/src/index.ts": "export function gamma(): number {\n  return 4;\n}\n",
  "..foo/x.ts": "export const x = 1;\n",
};
// Tracked symlinks: a dir link at the root and a file link beside its importer.
const LINKS: Record<string, string> = {
  clink: "packages/c",
  "packages/b/src/dlink.ts": "../../a/src/extra.ts",
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

/** Point a tracked symlink somewhere else on disk for the length of `body`, as a later checkout might. */
async function withLinkRetargeted(rel: string, target: string, body: () => Promise<void>): Promise<void> {
  const link = path.join(dir, rel);
  await fs.rm(link);
  await fs.symlink(target, link);
  try {
    await body();
  } finally {
    await fs.rm(link);
    await fs.symlink(LINKS[rel]!, link);
  }
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-git-tree-links-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-git-tree-outside-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  await writeAll(FIRST);
  for (const [rel, target] of Object.entries(LINKS)) await fs.symlink(target, path.join(dir, rel));
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

  it("follows a tracked dir symlink to the target the commit records, not today's", async () => {
    await withLinkRetargeted("clink", "packages/a", async () => {
      const atRev = await indexSnapshot({ source: gitTreeSource(dir, "HEAD~1") });

      expect(checkoutAtFirst.nodes.some((n) => n.includes('"signature":"v: number"'))).toBe(true);
      expect(atRev).toEqual(checkoutAtFirst);
    });
  });

  it("follows a tracked file symlink to the target the commit records, not today's", async () => {
    await withLinkRetargeted("packages/b/src/dlink.ts", "../../a/src/index.ts", async () => {
      const atRev = await indexSnapshot({ source: gitTreeSource(dir, "HEAD~1") });

      expect(atRev).toEqual(checkoutAtFirst);
    });
  });

  it("reads through a tracked symlink and lists it as one", () => {
    const host = gitTreeSource(dir, "HEAD~1").fileSystem;

    expect(host.readFileSync(path.join(dir, "packages/b/src/dlink.ts"))).toBe(FIRST["packages/a/src/extra.ts"]);
    expect(host.readFileSync(path.join(dir, "clink/src/index.ts"))).toBe(FIRST["packages/c/src/index.ts"]);
    expect(host.readDirSync(dir).find((e) => e.name.endsWith(`${path.sep}clink`))).toMatchObject({
      isSymlink: true,
      isDirectory: true,
      isFile: false,
    });
  });

  it("treats build output under an untracked dir as absent, like the dir itself", async () => {
    await writeAll({ "untr/dist/x.d.ts": "export declare const x: number;\n" });
    try {
      const host = gitTreeSource(dir, "HEAD~1").fileSystem;

      expect(host.directoryExistsSync(path.join(dir, "untr"))).toBe(false);
      expect(host.directoryExistsSync(path.join(dir, "untr/dist"))).toBe(false);
      expect(host.fileExistsSync(path.join(dir, "untr/dist/x.d.ts"))).toBe(false);
    } finally {
      await fs.rm(path.join(dir, "untr"), { recursive: true });
    }
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

// Link chains of CHAIN_LINKS ending at a tracked file; link `n` takes n hops, so 30 resolves and 45 loops.
// chain/ is committed and loose/ is made on disk after the commit; both resolve through the per-hop memo.
const CHAIN_LINKS = 45;
// nest/k -> k+1/../k+1/../k+1: without a memo per link, resolving nest/1 takes 3^NEST_DEPTH steps.
const NEST_DEPTH = 25;
// The barrel splits t.ts's inbound weight three ways, so its utilization sums thirds in file order.
const ORDERED: Record<string, string> = {
  "x.ts": "export const x = 1;\n",
  "chain/target.ts": "export const target = 1;\n",
  "lib/index.ts": 'export * from "./t.js";\nexport * from "./u.js";\nexport * from "./v.js";\n',
  "lib/t.ts": "export const t = 1;\n",
  "lib/u.ts": "export const u = 1;\n",
  "lib/v.ts": "export const v = 1;\n",
  "src/a.ts": 'import { t } from "../lib/index.js";\nexport const a = t;\n',
  "src/a/x.ts": 'import { t } from "../../lib/index.js";\nexport const ax = t + t;\n',
  "src/a-b/x.ts": 'import { t } from "../../lib/index.js";\nexport const abx = t + t + t + t;\n',
};

describe("gitTreeSource on link chains, dot-dot targets and file order", () => {
  let repo: string;
  const at = (rel: string) => path.join(repo, rel);
  const repoGit = (args: readonly string[]) => execFileSync("git", [...args], { cwd: repo, env: isolatedGitEnv() });

  beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-git-tree-chains-"));
    for (const [rel, content] of Object.entries(ORDERED)) {
      await fs.mkdir(path.dirname(at(rel)), { recursive: true });
      await fs.writeFile(at(rel), content);
    }
    await fs.symlink("target.ts", at("chain/1"));
    for (let n = 2; n <= CHAIN_LINKS; n++) await fs.symlink(String(n - 1), at(`chain/${n}`));
    await fs.mkdir(at("sub"));
    await fs.symlink("../gone/../x.ts", at("sub/dangling.ts"));
    await fs.symlink("../sub/../x.ts", at("sub/through.ts"));
    await fs.mkdir(at("nest/d"), { recursive: true });
    await fs.writeFile(at("nest/d/x.txt"), "");
    for (let k = 1; k < NEST_DEPTH; k++) await fs.symlink(`${k + 1}/../${k + 1}/../${k + 1}`, at(`nest/${k}`));
    await fs.symlink("d", at(`nest/${NEST_DEPTH}`));
    repoGit(["init", "-q", "-b", "main"]);
    repoGit(["add", "-A"]);
    repoGit(["-c", "user.name=alice", "-c", "user.email=alice@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "only"]);
    await fs.mkdir(at("loose"));
    await fs.symlink("../chain/target.ts", at("loose/1"));
    for (let n = 2; n <= CHAIN_LINKS; n++) await fs.symlink(String(n - 1), at(`loose/${n}`));
  }, 60_000);

  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it.each([
    ["tracked", "chain"],
    ["untracked", "loose"],
  ])("resolves a 30-link %s chain after a 45-link one that shares its tail was cut short", (_kind, chain) => {
    const host = gitTreeSource(repo, "HEAD").fileSystem;

    expect(host.fileExistsSync(at(`${chain}/${CHAIN_LINKS}`))).toBe(false);
    expect(host.fileExistsSync(at(`${chain}/30`))).toBe(true);
  });

  it("resolves '..' in a tracked link target against the dir reached, as a checkout does", () => {
    const host = gitTreeSource(repo, "HEAD").fileSystem;

    expect(host.fileExistsSync(at("sub/dangling.ts"))).toBe(existsSync(at("sub/dangling.ts")));
    expect(host.fileExistsSync(at("sub/dangling.ts"))).toBe(false);
    expect(host.readFileSync(at("sub/through.ts"))).toBe(ORDERED["x.ts"]);
  });

  it("resolves each tracked link once per hop budget when nested targets name it repeatedly", () => {
    const host = gitTreeSource(repo, "HEAD").fileSystem;
    const started = performance.now();

    host.fileExistsSync(at("nest/1/x.txt"));

    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("indexes files in the same order as a checkout, so float metrics match byte for byte", async () => {
    const index = async (options: Partial<IndexOptions>) => {
      const store = openCodeGraph(":memory:");
      try {
        const result = await indexPaths(store, { paths: [repo], incremental: false, detectRenames: false, computeChurn: false, ...options });
        return readSnapshot(store, result.snapshotId);
      } finally {
        store.close();
      }
    };

    const checkout = await index({});
    const atRev = await index({ source: gitTreeSource(repo, "HEAD") });

    expect(atRev.metrics).toEqual(checkout.metrics);
    expect(atRev).toEqual(checkout);
  });
});
