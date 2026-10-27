import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnExec, type Exec } from "@titan-design/fix-proof";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphEdge } from "../types.js";
import type { IstanbulCoverage } from "./coverage.js";
import { runExtremeMutation } from "./extreme-mutation.js";

const VITEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../node_modules/vitest/vitest.mjs");

const ADD = "packages/a/src/add.ts";
const LOG = "packages/a/src/log.ts";
const SHARED = "packages/a/src/shared.ts";
const ADD_TEST = "packages/a/src/add.test.ts";
const LOG_TEST = "packages/a/src/log.test.ts";
const SHARED_TEST = "packages/b/src/shared.test.ts";

const fn = (name: string) => `export function ${name}(n: number): number {\n  return n + 1;\n}\n`;
const FILES: Record<string, string> = {
  ".github/fix-proof.json": JSON.stringify({ tests: ["packages/*/src/**/*.test.ts"], command: `node ${VITEST} run --globals`, build: "true" }),
  "pnpm-lock.yaml": "",
  "packages/a/package.json": "{}",
  "packages/b/package.json": "{}",
  [ADD]: fn("add"),
  [LOG]: fn("logged"),
  [SHARED]: fn("shared"),
  [ADD_TEST]: 'import { add } from "./add";\ntest("adds", () => expect(add(1)).toBe(2));\n',
  [LOG_TEST]: 'import { logged } from "./log";\ntest("logs", () => console.log(logged(1)));\n',
  [SHARED_TEST]: 'import { shared } from "../../a/src/shared";\ntest("shares", () => expect(shared(1)).toBe(2));\n',
};
const EDGES: GraphEdge[] = [
  { srcId: ADD_TEST, dstId: ADD, kind: "imports" },
  { srcId: LOG_TEST, dstId: LOG, kind: "imports" },
  { srcId: SHARED_TEST, dstId: SHARED, kind: "imports" },
];

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function git(dir: string, args: string[]): string {
  const identity = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
  return execFileSync("git", [...identity, ...args], { cwd: dir, encoding: "utf-8" }).trim();
}

function fixtureRepo(): { dir: string; head: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extreme-mutation-"));
  dirs.push(dir);
  for (const [file, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "fixture"]);
  return { dir, head: git(dir, ["rev-parse", "HEAD"]) };
}

// The fixture's tests import source, not dist, so pnpm stands in as a no-op.
const noPnpm: Exec = (file, args, options) =>
  file === "sh" && (args[1] ?? "").startsWith("pnpm ") ? Promise.resolve({ status: 0, stdout: "", stderr: "" }) : spawnExec(file, args, options);

function coverageOf(dir: string): IstanbulCoverage {
  const hit = { fnMap: { "0": { loc: { start: { line: 1 }, end: { line: 3 } } } }, f: { "0": 1 } };
  return Object.fromEntries([ADD, LOG, SHARED].map((file) => [path.join(dir, file), hit]));
}

function options(dir: string, head: string) {
  const changed = new Map([ADD, LOG, SHARED].map((file) => [file, [[1, 3] as const]]));
  const coverage = { head, data: coverageOf(dir) };
  return { repo: dir, head, changed, coverage, store: { listEdges: () => EDGES }, snapshotId: 1, exec: noPnpm };
}

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(Object.keys(FILES).map((file) => [file, fs.readFileSync(path.join(dir, file), "utf-8")]));
}

describe("runExtremeMutation", { timeout: 120_000 }, () => {
  it("yields pseudo-tested and deletion-candidate findings and leaves every file as it was", async () => {
    const { dir, head } = fixtureRepo();
    const before = snapshot(dir);

    const { findings, summary, report } = await runExtremeMutation(options(dir, head));

    expect(report.error).toBeUndefined();
    expect(findings.map((f) => f.id).sort()).toEqual([
      `code-graph:pseudo-tested:${LOG}#logged`,
      `code-graph:test-deletion-candidate:${LOG_TEST}::logs`,
    ]);
    expect(summary).toMatchObject({ head, targets: 3, survived: 1, caught: 1, unverified: 1, deletionCandidates: 1 });
    expect(snapshot(dir)).toEqual(before);
    expect(git(dir, ["status", "--porcelain"])).toBe("");
    expect(git(dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
  });

  it("refuses coverage measured at another commit before running anything", async () => {
    const { dir, head } = fixtureRepo();
    fs.writeFileSync(path.join(dir, LOG), fn("logged") + "\n");
    git(dir, ["commit", "-q", "-am", "next"]);
    const next = git(dir, ["rev-parse", "HEAD"]);

    await expect(runExtremeMutation({ ...options(dir, next), coverage: { head, data: coverageOf(dir) } })).rejects.toThrow(
      /coverage was measured at/,
    );
  });

  it("runs nothing when no changed function is covered", async () => {
    const { dir, head } = fixtureRepo();

    const { findings, summary, report } = await runExtremeMutation({ ...options(dir, head), coverage: { head, data: {} } });

    expect(findings).toEqual([]);
    expect(report.runs).toEqual([]);
    expect(summary).toMatchObject({ targets: 0, builds: 0 });
    expect(summary.skipped.uncovered).toBe(3);
  });
});
