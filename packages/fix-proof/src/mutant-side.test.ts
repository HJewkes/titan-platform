import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnExec, type Exec } from "./exec.js";
import { execMutants } from "./mutant-side.js";
import { MAX_MUTATIONS, type Mutation } from "./mutation.js";
import { FIXED, makeRepo, REAL_RUNNER, removeRepos } from "./repo.test-helpers.js";
import { isSandboxed, sudoStub } from "./sandbox.test-helpers.js";
import { decodeMutantsReport, type DecodedMutants } from "./transport.js";

const DOUBLE = "export const double = (n: number) => n * 2;\n";
// The tests import the built copies, so a mutation is seen only after a rebuild and a restore only after another.
const DIST_BUILD = "mkdir -p dist && cp src/math.ts src/double.ts dist/";
const CALC_TEST = [
  'import { add } from "../dist/math";',
  'import { double } from "../dist/double";',
  'test("adds", () => expect(add(1, 2)).toBe(3));',
  'test("doubles", () => expect(double(2)).toBe(4));',
  "",
].join("\n");
const ADD_SUBTRACTS: Mutation = { name: "add subtracts", file: "src/math.ts", find: "a + b", replace: "a - b", kills: ["adds"] };
const DOUBLE_ADDS: Mutation = { name: "double adds", file: "src/double.ts", find: "n * 2", replace: "n + 3", kills: ["doubles"] };

const outs: string[] = [];

function outDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-proof-mutants-"));
  outs.push(dir);
  return dir;
}

afterEach(() => {
  removeRepos();
  outs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

function spec(...mutations: Mutation[]): string {
  return JSON.stringify({ v: 1, mutations });
}

interface Scenario {
  build?: string;
  /** The test reads no vitest outcome, so the runner only writes an empty report. */
  fakeRunner?: boolean;
  head: Record<string, string>;
  base?: Record<string, string>;
  exec?: Exec;
  sandboxUser?: string;
  out?: string;
}

async function runScenario({ build = DIST_BUILD, fakeRunner = false, head, base = {}, exec, sandboxUser, out = outDir() }: Scenario): Promise<DecodedMutants> {
  const repo = makeRepo(fakeRunner ? { build } : { ...REAL_RUNNER, build }, os.tmpdir(), { "src/math.ts": FIXED, "src/double.ts": DOUBLE, ...base });
  const sha = repo.commit(head);
  await execMutants({ repo: repo.dir, base: repo.base, head: sha, out, exec, sandboxUser });
  return decodeMutantsReport(fs.readFileSync(path.join(out, "mutants.report"), "utf-8"));
}

function refusedIn(out: string): string | null {
  const file = path.join(out, "mutants.refused");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
}

function listOf(value: unknown, key: string): unknown[] {
  const list: unknown = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  return Array.isArray(list) ? list : [];
}

function statuses(report: unknown): Record<string, unknown> {
  const tests = listOf(report, "testResults").flatMap((file) => listOf(file, "assertionResults"));
  return Object.fromEntries(tests.map((test) => [String(Reflect.get(Object(test), "title")), Reflect.get(Object(test), "status")]));
}

function runsOf(decoded: DecodedMutants) {
  if (!decoded.ok || decoded.skipped !== undefined) throw new Error(`no runs: ${JSON.stringify(decoded)}`);
  return decoded;
}

const calcSpec = (...mutations: Mutation[]) => ({ "src/calc.test.ts": CALC_TEST, "src/calc.test.mutations.json": spec(...mutations) });

describe("execMutants", { timeout: 120_000 }, () => {
  it("runs a baseline, then each mutation alone, restoring and rebuilding the file before the next", async () => {
    const decoded = runsOf(await runScenario({ head: calcSpec(ADD_SUBTRACTS, DOUBLE_ADDS) }));

    expect(statuses(decoded.baseline)).toEqual({ adds: "passed", doubles: "passed" });
    expect(decoded.runs.map((run) => [run.spec, run.name, run.built])).toEqual([
      ["src/calc.test.mutations.json", "add subtracts", true],
      ["src/calc.test.mutations.json", "double adds", true],
    ]);
    expect(statuses(decoded.runs[0]?.report)).toEqual({ adds: "failed", doubles: "passed" });
    expect(statuses(decoded.runs[1]?.report)).toEqual({ adds: "passed", doubles: "failed" });
  });

  it("a mutation whose rebuild fails is recorded unbuilt, and the next mutation runs on a restored tree", async () => {
    const build = `if grep -q BROKEN src/math.ts; then exit 1; fi; ${DIST_BUILD}`;
    const breaks: Mutation = { ...ADD_SUBTRACTS, name: "breaks the build", replace: "BROKEN" };

    const decoded = runsOf(await runScenario({ build, head: calcSpec(breaks, DOUBLE_ADDS) }));

    expect(decoded.runs.map((run) => run.built)).toEqual([false, true]);
    expect(statuses(decoded.runs[1]?.report)).toEqual({ adds: "passed", doubles: "failed" });
  });

  it("with no mutation spec in the diff writes a skipped marker", async () => {
    expect(await runScenario({ head: { "src/calc.test.ts": CALC_TEST } })).toEqual({ ok: true, skipped: "no mutation spec in the diff" });
  });

  it("with source in the diff writes a skipped marker naming it and runs nothing, though the find is in no merge-base text", async () => {
    const built = path.join(outDir(), "built");
    const out = outDir();
    const triples: Mutation = { ...DOUBLE_ADDS, find: "n * 3" };

    const decoded = await runScenario({ build: `touch ${built}`, head: { ...calcSpec(triples), "src/double.ts": DOUBLE.replace("2", "3") }, out });

    expect(decoded).toEqual({ ok: true, skipped: "the diff changes source: src/double.ts" });
    expect(fs.existsSync(built)).toBe(false);
    expect(refusedIn(out)).toBeNull();
  });

  it.each([
    ["targets its own test file", { ...DOUBLE_ADDS, file: "src/calc.test.ts", find: "doubles" }, "src/calc.test.ts is a test"],
    ["has a find not in the file at head", { ...DOUBLE_ADDS, find: "n * 9" }, "find does not occur in src/double.ts at head"],
    ["has a find twice in the file at head", { ...DOUBLE_ADDS, find: "n" }, "find occurs more than once in src/double.ts at head"],
    ["targets a file missing at head", { ...DOUBLE_ADDS, file: "src/gone.ts" }, "src/gone.ts does not exist at head"],
  ])("with source in the diff, a spec whose mutation %s is refused", async (_what, mutation, error) => {
    const out = outDir();

    await runScenario({ head: { ...calcSpec(mutation), "src/double.ts": DOUBLE.replace("2", "3") }, out });

    expect(refusedIn(out)).toContain(`src/calc.test.mutations.json: mutation double adds: ${error}`);
  });

  it("with source in the diff, a git failure reading the specs is refused, since no judge reads them", async () => {
    const out = outDir();
    const exec: Exec = (file, args, options) =>
      args.includes("-r") && args.includes("--name-only") ? Promise.resolve({ status: 1, stdout: "", stderr: "" }) : spawnExec(file, args, options);

    await runScenario({ head: { ...calcSpec(DOUBLE_ADDS), "src/double.ts": DOUBLE.replace("2", "3") }, exec, out });

    expect(refusedIn(out)).toContain("listing the spec's directory failed");
  });

  it("with source in the diff, a spec over the mutation cap is refused, not skipped", async () => {
    const built = path.join(outDir(), "built");
    const out = outDir();
    const overCap = Array.from({ length: MAX_MUTATIONS + 1 }, (_, index) => ({ ...DOUBLE_ADDS, name: `double adds ${index}` }));

    const decoded = await runScenario({ build: `touch ${built}`, head: { ...calcSpec(...overCap), "src/double.ts": DOUBLE.replace("2", "3") }, out });

    expect(refusedIn(out)).toContain(`src/calc.test.mutations.json: mutation spec: spec.mutations must hold 1 to ${MAX_MUTATIONS} mutations`);
    expect(decoded).toEqual({ ok: false, error: expect.stringContaining("must hold 1 to"), reported: true });
    expect(fs.existsSync(built)).toBe(false);
  });

  it("with source in the diff, a spec with no test beside it is refused", async () => {
    const out = outDir();

    await runScenario({ head: { "src/calc.test.mutations.json": spec(DOUBLE_ADDS), "src/double.ts": DOUBLE.replace("2", "3") }, out });

    expect(refusedIn(out)).toContain("src/calc.test.mutations.json: no single test file sits beside it");
  });

  it("a spec whose find is not in the merge-base file writes an error marker and is refused", async () => {
    const out = outDir();

    const decoded = await runScenario({ head: calcSpec({ ...DOUBLE_ADDS, find: "n * 9" }), out });

    expect(decoded).toEqual({ ok: false, error: expect.stringContaining("find does not occur in src/double.ts"), reported: true });
    expect(refusedIn(out)).toContain("find does not occur in src/double.ts");
  });

  it.each([
    ["the mutated file", "lib/double.ts", /ELOOP/],
    ["the mutated file's directory", "lib", /lib\/double\.ts is not inside the tree/],
  ])("a symlink head code plants in place of %s is never written through", async (_what, planted, error) => {
    const outside = outDir();
    fs.writeFileSync(path.join(outside, "double.ts"), DOUBLE);
    const target = planted === "lib" ? outside : path.join(outside, "double.ts");
    const plant = `import * as fs from "node:fs";\nfs.rmSync(${JSON.stringify(planted)}, { recursive: true });\nfs.symlinkSync(${JSON.stringify(target)}, ${JSON.stringify(planted)});\n`;
    const test = plant + 'test("doubles", () => expect(1).toBe(1));\n';
    const mutation: Mutation = { ...DOUBLE_ADDS, file: "lib/double.ts" };

    const decoded = await runScenario({ build: "true", base: { "lib/double.ts": DOUBLE }, head: { "src/calc.test.ts": test, "src/calc.test.mutations.json": spec(mutation) } });

    expect(decoded).toEqual({ ok: false, error: expect.stringMatching(error), reported: true });
    expect(fs.readFileSync(path.join(outside, "double.ts"), "utf-8")).toBe(DOUBLE);
  });

  it("with a sandbox user, every build and vitest call after the overlay runs in the sandbox", async () => {
    const { calls, exec } = sudoStub();

    const decoded = await runScenario({ head: calcSpec(ADD_SUBTRACTS, DOUBLE_ADDS), exec, sandboxUser: "fix-proof-sandbox", fakeRunner: true });

    const isVitest = (args: readonly string[]) => args.includes("--reporter=json");
    const isBuild = (args: readonly string[]) => args.some((arg) => arg.startsWith(DIST_BUILD));
    expect(runsOf(decoded).runs).toHaveLength(2);
    expect(calls.filter((call) => isSandboxed(call) && isVitest(call.args))).toHaveLength(3);
    expect(calls.filter((call) => isSandboxed(call) && isBuild(call.args))).toHaveLength(4);
    expect(calls.filter((call) => call.file === "sh" && isVitest(call.args))).toEqual([]);
    expect(calls.filter((call) => call.file === "sh" && isBuild(call.args))).toHaveLength(1);
  });

  it("in a pnpm workspace rebuilds only the package that owns the mutated file", async () => {
    const pnpm: string[][] = [];
    const exec: Exec = (file, args, options) => {
      if (file !== "sh" || !(args[1] ?? "").startsWith("pnpm ")) return spawnExec(file, args, options);
      pnpm.push([...args.slice(1)]);
      return Promise.resolve({ status: 0, stdout: "", stderr: "" });
    };
    const base = { "pnpm-lock.yaml": "", "packages/a/package.json": "{}", "packages/a/src/sum.ts": FIXED };
    const mutation: Mutation = { ...ADD_SUBTRACTS, file: "packages/a/src/sum.ts" };
    const head = { "packages/a/src/sum.test.ts": 'import { add } from "./sum";\ntest("adds", () => expect(add(1, 2)).toBe(3));\n', "packages/a/src/sum.test.mutations.json": spec(mutation) };

    const decoded = await runScenario({ build: "true", base, head, exec });

    expect(statuses(runsOf(decoded).runs[0]?.report)).toEqual({ adds: "failed" });
    const rebuild = ['pnpm --filter "$@"', "sh", "./packages/a", "run", "--if-present", "build"];
    expect(pnpm.filter((args) => args[0]?.startsWith("pnpm --filter"))).toEqual([rebuild, rebuild]);
  });

  it("in a pnpm workspace a mutated file outside every package is not rebuilt, and is restored", async () => {
    const builds: string[][] = [];
    const exec: Exec = (file, args, options) => {
      if (file === "sh" && args[1] === 'true "$@"') builds.push([...args.slice(1)]);
      // The empty lockfile cannot install anywhere, so only the install is stubbed.
      if (file === "sh" && (args[1] ?? "").startsWith("pnpm ")) return Promise.resolve({ status: 0, stdout: "", stderr: "" });
      return spawnExec(file, args, options);
    };
    const script = "export const add = (a, b) => a + b;\n";
    const base = { "pnpm-lock.yaml": "", "scripts/sum.mjs": script };
    const mutation: Mutation = { ...ADD_SUBTRACTS, file: "scripts/sum.mjs" };
    const test = 'import { add } from "./sum.mjs";\ntest("adds", () => expect(add(1, 2)).toBe(3));\n';
    const head = { "scripts/sum.test.mjs": test, "scripts/sum.test.mutations.json": spec(mutation) };

    const decoded = await runScenario({ build: "true", base, head, exec });

    expect(statuses(runsOf(decoded).runs[0]?.report)).toEqual({ adds: "failed" });
    // Only the merge base's own prepare build runs; neither the mutant nor its restore rebuilds.
    expect(builds).toHaveLength(1);
  });
});
