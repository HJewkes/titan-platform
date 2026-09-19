import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { indexPaths, openCodeGraph, type CodeGraphStore } from "@titan-design/code-graph";

/** A throwaway git repository indexed into its own code-graph store, for tests that need real snapshots. */
export interface FixtureRepo {
  dir: string;
  store: CodeGraphStore;
  write(relPath: string, contents: string): Promise<void>;
  commit(message: string): string;
  /** Index the working tree as one snapshot of `ref`; returns the snapshot id. */
  index(ref: string): Promise<number>;
  cleanup(): Promise<void>;
}

// Real commit times, so the default churn windows see the fixture's history.
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };

export const FIXTURE_FILES: Record<string, string> = {
  "src/math.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  "src/index.ts": 'import { add } from "./math.js";\n\nexport const total = add(1, 2);\n',
  "src/util/strings.ts": "export function shout(s: string): string {\n  if (!s) return s;\n  return s.toUpperCase();\n}\n",
};

export async function makeFixtureRepo(): Promise<FixtureRepo> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "code-read-fixture-")));
  const git = (args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV });
  git(["init", "-q", "-b", "main"]);
  const store = openCodeGraph(path.join(dir, ".git", "graph.sqlite3"));
  const write = async (relPath: string, contents: string): Promise<void> => {
    await fs.mkdir(path.dirname(path.join(dir, relPath)), { recursive: true });
    await fs.writeFile(path.join(dir, relPath), contents);
  };
  for (const [relPath, contents] of Object.entries(FIXTURE_FILES)) await write(relPath, contents);
  const commit = (message: string): string => {
    git(["add", "-A"]);
    git(["-c", "user.name=alice", "-c", "user.email=alice@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
    return git(["rev-parse", "HEAD"]).trim();
  };
  const index = async (ref: string): Promise<number> => (await indexPaths(store, { paths: [dir], ref })).snapshotId;
  const cleanup = async (): Promise<void> => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  };
  return { dir, store, write, commit, index, cleanup };
}

/** Nested directories, two `run` methods in different classes, an empty file, and a test file, for hierarchy tests. */
export const HIERARCHY_FILES: Record<string, string> = {
  "src/jobs/runner.ts": [
    "export class Job {",
    "  run(n: number): number {",
    "    if (n > 1) return n * 2;",
    "    return n;",
    "  }",
    "}",
    "",
    "export class Task {",
    "  run(items: number[]): number {",
    "    let total = 0;",
    "    for (const i of items) {",
    "      if (i > 0) total += i;",
    "    }",
    "    return total;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/deep/a/b/leaf.ts": "export function leaf(x: number): number {\n  return x > 0 ? x : -x;\n}\n",
  "src/deep/a/sibling.ts": "export const one = 1;\nexport const two = 2;\n",
  "src/types.ts": "export type Id = string;\n",
  // Empty: the indexer writes no complexity, nesting, or bus-factor row for it.
  "src/empty.ts": "",
  "src/math.test.ts": 'import { add } from "./math.js";\n\nif (add(1, 1) !== 2) throw new Error("add");\n',
};

export async function makeHierarchyRepo(): Promise<FixtureRepo> {
  const repo = await makeFixtureRepo();
  for (const [relPath, contents] of Object.entries(HIERARCHY_FILES)) await repo.write(relPath, contents);
  return repo;
}
