import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitTreeSource } from "./git-tree-source.js";
import { readSnapshot, type Snapshot } from "./incremental.test-helpers.js";
import { indexPaths, type IndexOptions } from "./indexer.js";
import { ALIAS_BASE_ATTR } from "./identity/lineage.js";
import { daysAgo, isolatedGitEnv } from "./history/test-repo.js";
import { openCodeGraph } from "./store.js";

// HEAD~1. The tsconfig path alias and the .gitattributes rule both change in the
// working tree, so an index that read either from disk would differ.
const FIRST: Record<string, string> = {
  ".gitignore": "node_modules\n",
  ".gitattributes": "src/gen.ts linguist-generated\n",
  "tsconfig.json": JSON.stringify({
    compilerOptions: { strict: true, module: "nodenext", baseUrl: ".", paths: { "@lib/*": ["lib/*"] } },
    include: ["src", "lib", "sub"],
  }),
  "src/a.ts": "export const A = 1;\n",
  "src/b.ts": 'import { A } from "./a.js";\nimport { util } from "@lib/util";\nimport { dep } from "dep";\nexport const B = util(A) + dep;\n',
  "src/gen.ts": "export const generated = true;\n",
  "lib/util.ts": "export function util(n: number): number {\n  return n;\n}\n",
  "sub/c.ts": 'import { A } from "../src/a.js";\nexport class C {\n  run(): number {\n    return A;\n  }\n}\n',
  "py/app.py": "import util\n\nutil.run()\n",
  "py/util.py": "def run():\n    return 1\n",
};
const SECOND: Record<string, string> = {
  "src/a.ts": "export const A = 1;\nexport const A2 = 2;\n",
  "src/later.ts": "export const later = 1;\n",
};
const WORKING_EDITS: Record<string, string> = {
  "src/b.ts": "export const B = 2;\n",
  "src/extra.ts": "export function extra(): void {}\n",
  ".gitattributes": "\n",
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
};
// Installed for the working tree and never committed: read from disk at any revision.
const NODE_MODULES: Record<string, string> = {
  "node_modules/dep/package.json": JSON.stringify({ name: "dep", types: "index.d.ts" }),
  "node_modules/dep/index.d.ts": "export declare const dep: number;\n",
};

let dir: string;
let firstSha: string;
let checkoutAtFirst: { whole: Snapshot; sub: Snapshot; churnNames: Set<string> };

const git = (args: readonly string[]) =>
  execFileSync("git", [...args], { cwd: dir, encoding: "utf-8", env: isolatedGitEnv(daysAgo(3)) }).trim();

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

async function indexInto(options: Partial<IndexOptions>) {
  const store = openCodeGraph(":memory:");
  try {
    const result = await indexPaths(store, {
      paths: [dir],
      tsConfig: path.join(dir, "tsconfig.json"),
      incremental: false,
      detectRenames: false,
      ...options,
    });
    const snapshot = readSnapshot(store, result.snapshotId);
    const row = store.listSnapshots({ limit: 1 })[0]!;
    return { snapshot, commitHash: row.commitHash, metricNames: new Set(store.listMetrics(result.snapshotId).map((m) => m.name)) };
  } finally {
    store.close();
  }
}

/** Every file outside .git with its content, so any write the index made shows up. */
async function workingTreeFiles(root = dir): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await fs.readdir(root, { withFileTypes: true, recursive: true })) {
    const abs = path.join(entry.parentPath, entry.name);
    if (!entry.isFile() || path.relative(root, abs).split(path.sep)[0] === ".git") continue;
    out[path.relative(root, abs)] = await fs.readFile(abs, "utf-8");
  }
  return out;
}

beforeAll(async () => {
  // Deliberately not realpath'd: on macOS os.tmpdir() sits behind the /var symlink.
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-git-tree-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  await writeAll({ ...FIRST, ...NODE_MODULES });
  commit("first");
  firstSha = git(["rev-parse", "HEAD"]);
  await writeAll(SECOND);
  commit("second");

  git(["checkout", "-q", firstSha]);
  const whole = await indexInto({ computeChurn: false });
  const sub = await indexInto({ paths: [path.join(dir, "sub")], computeChurn: false });
  const churned = await indexInto({});
  checkoutAtFirst = { whole: whole.snapshot, sub: sub.snapshot, churnNames: churned.metricNames };
  git(["checkout", "-q", "main"]);

  await writeAll(WORKING_EDITS);
  await fs.rm(path.join(dir, "sub"), { recursive: true });
}, 60_000);

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("gitTreeSource", () => {
  it("indexes HEAD~1 with the same nodes, edges and metrics as a checkout of it", async () => {
    const atRev = await indexInto({ source: gitTreeSource(dir, "HEAD~1"), computeChurn: false });

    expect(atRev.snapshot).toEqual(checkoutAtFirst.whole);
    expect(atRev.snapshot.nodes.some((n) => n.includes('"name":"later.ts"'))).toBe(false);
    // Only the commit's tsconfig maps @lib/*, and only its .gitattributes marks gen.ts.
    expect(atRev.snapshot.nodes.some((n) => n.includes('"signature":"B: number"'))).toBe(true);
    expect(atRev.snapshot.nodes.some((n) => n.includes('"id":"src/gen.ts"') && n.includes('"role":"generated"'))).toBe(true);
  });

  it("roots ids at the repo root when the indexed subdir is gone from the working tree", async () => {
    const atRev = await indexInto({
      paths: [path.join(dir, "sub")],
      source: gitTreeSource(dir, "HEAD~1"),
      computeChurn: false,
    });

    expect(atRev.snapshot.nodes.length).toBeGreaterThan(0);
    expect(atRev.snapshot).toEqual(checkoutAtFirst.sub);
  });

  it("records the source's commit as the snapshot's commitHash", async () => {
    const atRev = await indexInto({ source: gitTreeSource(dir, "HEAD~1") });

    expect(atRev.commitHash).toBe(firstSha);
  });

  it("bridges aliases from the source's commit, not the working tree's HEAD", async () => {
    const store = openCodeGraph(":memory:");
    try {
      const index = (rev: string) =>
        indexPaths(store, { paths: [dir], ref: "rev", incremental: false, source: gitTreeSource(dir, rev) });
      await index("HEAD");
      const atFirst = await index("HEAD~1");

      // HEAD is not an ancestor of HEAD~1, so HEAD~1's index has no alias base.
      expect(store.listSnapshots().find((s) => s.id === atFirst.snapshotId)?.attrs[ALIAS_BASE_ATTR]).toBeNull();
    } finally {
      store.close();
    }
  });

  it("records the same history metrics as a checkout of the revision", async () => {
    const atRev = await indexInto({ source: gitTreeSource(dir, "HEAD~1") });

    expect(checkoutAtFirst.churnNames.has("churn_30d")).toBe(true);
    const history = /^(churn_|bus_factor_|top_author_share_|test_bus_factor_|test_top_author_share_|recency_|file_age_days)/;
    const historyNames = (names: Set<string>) => [...names].filter((name) => history.test(name)).sort();
    expect(historyNames(atRev.metricNames)).toEqual(historyNames(checkoutAtFirst.churnNames));
  });

  it("writes nothing in the repo", async () => {
    const statusBefore = git(["status", "--porcelain"]);
    const filesBefore = await workingTreeFiles();

    await indexInto({ source: gitTreeSource(dir, "HEAD~1") });

    expect(git(["status", "--porcelain"])).toBe(statusBefore);
    expect(await workingTreeFiles()).toEqual(filesBefore);
  });

  it("throws an error naming an unknown revision", () => {
    expect(() => gitTreeSource(dir, "no-such-branch")).toThrow(/Unknown git revision "no-such-branch"/);
  });

  it("exposes the commit and its epoch", () => {
    const source = gitTreeSource(dir, "HEAD~1");

    expect(source.revision?.commit).toBe(firstSha);
    expect(source.revision?.commitEpoch).toBe(Number(git(["show", "-s", "--format=%ct", firstSha])));
  });
});
