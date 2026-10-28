import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnExec, type Exec } from "./exec.js";
import { execHeadMutants, type HeadMutantsReport } from "./head-side.js";
import type { HeadMutation } from "./mutation.js";
import { git, makeRepo, removeRepos } from "./repo.test-helpers.js";

const LIB = "packages/a/src/lib.ts";
const TEST = "packages/a/src/lib.test.ts";
const LIB_TEXT = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "export function logged(n: number): number {",
  "  return n * 2;",
  "}",
  "export function shape(n: number): { size: number } {",
  "  return { size: n };",
  "}",
  "export function settled(n: number): Promise<number> {",
  "  return Promise.resolve(n);",
  "}",
  "",
].join("\n");
const TEST_TEXT = [
  'import { add, logged, settled, shape } from "./lib";',
  'test("adds", () => expect(add(1, 2)).toBe(3));',
  'test("logs", () => console.log(logged(2)));',
  'test("reads size", () => { if (shape(2).size !== 2) throw new Error("wrong size"); });',
  'test("waits", async () => { if ((await settled(1)) === undefined) await new Promise(() => undefined); }, 300);',
  "",
].join("\n");

function bodyDelete(symbol: string, header: string): HeadMutation {
  return { name: `body-delete:${symbol}`, file: LIB, find: header, replace: `${header} return undefined as never;` };
}

const ADD = bodyDelete("add", "export function add(a: number, b: number): number {");
const LOGGED = bodyDelete("logged", "export function logged(n: number): number {");
const SHAPE = bodyDelete("shape", "export function shape(n: number): { size: number } {");
const SETTLED = bodyDelete("settled", "export function settled(n: number): Promise<number> {");

afterEach(() => removeRepos());

// The fixture's tests import source, not dist, so pnpm stands in as a no-op that only counts the package rebuilds.
function countingPnpm() {
  const rebuilds: string[][] = [];
  const exec: Exec = (file, args, options) => {
    const script = args[1] ?? "";
    if (file !== "sh" || !script.startsWith("pnpm ")) return spawnExec(file, args, options);
    if (script.startsWith("pnpm --filter")) rebuilds.push([...args.slice(3)]);
    return Promise.resolve({ status: 0, stdout: "", stderr: "" });
  };
  return { rebuilds, exec };
}

function fixture() {
  const repo = makeRepo({}, os.tmpdir(), { "pnpm-lock.yaml": "", "packages/a/package.json": "{}", [LIB]: LIB_TEXT, [TEST]: TEST_TEXT });
  return { repo, head: repo.base };
}

async function run(mutations: HeadMutation[], budgetMs?: number) {
  const { repo, head } = fixture();
  const { rebuilds, exec } = countingPnpm();
  const report = await execHeadMutants({ repo: repo.dir, head, mutations, budgetMs, exec });
  return { repo, head, rebuilds, report };
}

function outcomes(report: HeadMutantsReport) {
  return Object.fromEntries(report.runs.map((r) => [r.name, r.outcome ?? r.error]));
}

describe("execHeadMutants", { timeout: 120_000 }, () => {
  it("classifies each body-delete mutant by how the owning package's suite noticed it", async () => {
    const { head, report } = await run([ADD, LOGGED, SHAPE, SETTLED]);

    expect(report.error).toBeUndefined();
    expect(report.head).toBe(head);
    expect(report.suites).toEqual({ "packages/a": [TEST] });
    expect(report.baseline.map((t) => [t.test, t.status])).toEqual([
      ["adds", "passed"],
      ["logs", "passed"],
      ["reads size", "passed"],
      ["waits", "passed"],
    ]);
    expect(outcomes(report)).toEqual({
      "body-delete:add": "caught",
      "body-delete:logged": "survived",
      "body-delete:shape": "caught-error",
      "body-delete:settled": "timeout",
    });
    expect(report.runs.find((r) => r.name === SHAPE.name)?.failed).toEqual([{ test: "reads size", file: TEST, assertion: false }]);
    expect(report.unrun).toEqual([]);
  });

  it("two mutants in one package rebuild it three times: once each, and once to restore", async () => {
    const { rebuilds, report } = await run([ADD, LOGGED]);

    expect(report.runs.map((r) => r.package)).toEqual(["packages/a", "packages/a"]);
    expect(rebuilds).toEqual([0, 1, 2].map(() => ["./packages/a", "run", "--if-present", "build"]));
    expect(report.builds).toBe(3);
  });

  it("leaves the caller's checkout, its status and its worktree list unchanged", async () => {
    const { repo } = await run([ADD, SHAPE]);

    expect(fs.readFileSync(path.join(repo.dir, LIB), "utf-8")).toBe(LIB_TEXT);
    expect(git(repo.dir, ["status", "--porcelain"])).toBe("");
    expect(git(repo.dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
  });

  it("with a 1 ms budget runs nothing and lists every mutation unrun", async () => {
    const { report } = await run([ADD, LOGGED], 1);

    expect(report.runs).toEqual([]);
    expect(report.unrun).toEqual([ADD.name, LOGGED.name]);
    expect(report.error).toBe("timeout");
  });

  it("a find absent at head is an error for that mutation alone, and the others still run", async () => {
    const absent: HeadMutation = { ...ADD, name: "absent", find: "export function gone() {" };

    const { report } = await run([absent, ADD]);

    expect(report.error).toBeUndefined();
    expect(outcomes(report)).toEqual({ absent: `mutation absent: find does not occur in ${LIB} at head`, "body-delete:add": "caught" });
    expect(report.runs[0]?.built).toBe(false);
  });
});
