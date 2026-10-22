import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { FIXED, makeRepo, parsed, REAL_TEST, removeRepos } from "./repo.test-helpers.js";
import { decodeReport, MAX_ENCODED_BYTES } from "./transport.js";

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const outs: string[] = [];

afterEach(() => {
  removeRepos();
  outs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

function node(entry: string, args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [path.join(DIST, entry), ...args], { cwd, encoding: "utf-8" });
  return { status: result.status, lines: result.stdout.split("\n").filter((line) => line !== "") };
}

const ADD_SUBTRACTS = { name: "add subtracts", file: "src/math.ts", find: "a + b", replace: "a - b", kills: ["adds"] };
// The shape of the tp#1374 evidence: the mutant fails its test through a thrown wait error, not an assertion.
const THROWING_TEST = 'import { add } from "./math";\ntest("adds", () => { if (add(1, 2) !== 3) throw new Error("sum not reached within 10 ms"); });\n';

async function mutantsVerdict(test: string) {
  const repo = makeRepo({}, os.tmpdir(), { "src/math.ts": FIXED });
  const head = repo.commit({ "src/math.test.ts": test, "src/math.test.mutations.json": JSON.stringify({ v: 1, mutations: [ADD_SUBTRACTS] }) });
  const out = outDir();
  const shas = ["--base", repo.base, "--head", head];

  const exec = await runCli(["exec", "--side", "mutants", ...shas, "--out", out], repo.dir);
  const absent = path.join(out, "absent.report");
  const line = await runCli(["judge", ...shas, "--base-report", absent, "--head-report", absent, "--mutants-report", path.join(out, "mutants.report")], repo.dir);
  return { exec, mutants: parsed(line).mutants };
}

function outDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-proof-cli-"));
  outs.push(dir);
  return dir;
}

describe("fix-proof cli", { timeout: 120_000 }, () => {
  it("judge with a missing report file prints an error verdict and exits 0", () => {
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });
    const missing = path.join(outDir(), "absent.report");

    const result = node("judge.js", ["--base", repo.base, "--head", head, "--base-report", missing, "--head-report", missing], repo.dir);

    expect(result.status).toBe(0);
    expect(result.lines).toHaveLength(1);
    expect(parsed(result.lines[0] ?? "")).toMatchObject({ head, mergeBase: repo.base, verdict: "error", error: "base: missing report" });
  });

  it("exec --side other is a usage error line", async () => {
    const result = parsed(await runCli(["exec", "--side", "other", "--base", "a", "--head", "b", "--out", "x"], os.tmpdir()));

    expect(result.verdict).toBe("error");
    expect(result.error).toContain("usage: fix-proof exec --side base|head|mutants");
  });

  it.each(["root; rm", "Root", ""])("exec --sandbox-user %j is a usage error line", async (user) => {
    const result = parsed(await runCli(["exec", "--side", "base", "--base", "a", "--head", "b", "--out", "x", "--sandbox-user", user], os.tmpdir()));

    expect(result).toMatchObject({ verdict: "error", error: expect.stringContaining("[--sandbox-user <name>]") });
  });

  it("exec passes --sandbox-user on to the base side, which fails closed for a user it cannot set up", async () => {
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });
    const out = outDir();

    const line = await runCli(["exec", "--side", "base", "--base", repo.base, "--head", head, "--out", out, "--sandbox-user", "fix-proof-absent-user"], repo.dir);

    expect(line).toBe("");
    expect(decodeReport(fs.readFileSync(path.join(out, "base.report"), "utf-8"))).toMatchObject({ ok: false, reported: true });
  });

  it("exec --side mutants and judge --mutants-report kill a mutation that fails its test on a real vitest assertion", async () => {
    const { exec, mutants } = await mutantsVerdict(REAL_TEST);

    expect(exec).toBe("");
    expect(mutants).toEqual({ verdict: "killed", results: [{ spec: "src/math.test.mutations.json", name: "add subtracts", outcome: "killed" }], uncovered: [] });
  });

  it("a mutation whose test fails by a thrown Error rather than an assertion is not killed", async () => {
    const { mutants } = await mutantsVerdict(THROWING_TEST);

    expect(mutants).toMatchObject({ verdict: "not-killed", results: [{ name: "add subtracts", outcome: "error" }] });
  });

  it("an unknown subcommand is a usage error line", async () => {
    const result = parsed(await runCli(["prove", "--base", "a", "--head", "b"], os.tmpdir()));

    expect(result).toMatchObject({ verdict: "error", error: expect.stringContaining("usage: fix-proof run|exec|judge") });
  });

  it("judge.js refuses a run subcommand rather than building anything", () => {
    const repo = makeRepo({ build: "touch built" });
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });

    const result = node("judge.js", ["run", "--base", repo.base, "--head", head], repo.dir);

    expect(result.status).toBe(0);
    expect(parsed(result.lines[0] ?? "").verdict).toBe("error");
    expect(fs.existsSync(path.join(repo.dir, "built"))).toBe(false);
  });

  it("judge refuses a report file over the encoded cap", async () => {
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });
    const big = path.join(outDir(), "big.report");
    fs.writeFileSync(big, "A".repeat(MAX_ENCODED_BYTES + 100));

    const line = await runCli(["judge", "--base", repo.base, "--head", head, "--base-report", big, "--head-report", big], repo.dir);

    expect(parsed(line)).toMatchObject({ verdict: "error", error: `base: report over ${MAX_ENCODED_BYTES} bytes` });
  });

  it("exec base, exec head and judge as separate processes prove a reproducing test", () => {
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });
    const out = outDir();
    const shas = ["--base", repo.base, "--head", head];

    const exec = (side: string) => node("bin.js", ["exec", "--side", side, ...shas, "--out", out], repo.dir);
    const sides = [exec("base"), exec("head")];
    const reports = ["--base-report", "base.report", "--base-rerun-report", "base-rerun.report", "--head-report", "head.report"];
    const judged = node("judge.js", [...shas, "--repo", repo.dir, ...reports], out);

    expect(sides).toEqual([{ status: 0, lines: [] }, { status: 0, lines: [] }]);
    expect(fs.readdirSync(out).sort()).toEqual(["base-rerun.report", "base.report", "head.report"]);
    expect(judged.lines).toHaveLength(1);
    expect(parsed(judged.lines[0] ?? "")).toMatchObject({ head, verdict: "reproduced" });
  });
});
