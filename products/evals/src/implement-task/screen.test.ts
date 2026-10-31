import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyReports, spawnExec, type Classification, type Exec } from "@titan-design/fix-proof";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCREEN_BUDGET_MS, screenCase, screenVerdict, type HeadRuns } from "./screen.js";
import { buildMergedPr, git, type MergedPr } from "./test-fixture.js";
import type { ImplementTaskSource } from "./write-case.js";

const FILE = "src/x.test.ts";
const OTHER = "src/y.test.ts";
const WRONG_ANSWER = "AssertionError: expected 1 to be 2";
const NO_EXPORT = "TypeError: x is not a function";

type Report = Record<string, unknown>;

const test_ = (fullName: string, status: string, failure?: string): Report => ({ fullName, status, failureMessages: failure === undefined ? [] : [failure] });
const fileReport = (status: string, tests: Report[], name = FILE): Report => ({ name: `/${name}`, status, assertionResults: tests });

const passing = fileReport("passed", [test_("x", "passed")]);
const failingOnHead = fileReport("failed", [test_("x", "failed", WRONG_ANSWER)]);
const failingOnBase = fileReport("failed", [test_("x", "failed", WRONG_ANSWER)]);
const loadError = fileReport("failed", []);

function classified(head: Report[], base: Report[] = [failingOnBase], selected: string[] = [FILE]): Classification {
  return classifyReports({ selected, base: { root: "/", report: { testResults: base } }, head: { root: "/", report: { testResults: head } } });
}

const thrice = (run: Classification): HeadRuns => [run, run, run];

describe("screenVerdict", () => {
  it("three identical runs with one reproducing test keep the case", () => {
    expect(screenVerdict(thrice(classified([passing])))).toBe("keep");
  });

  it("a passes-on-base test beside a reproducing one keeps the case", () => {
    const head = fileReport("passed", [test_("x", "passed"), test_("still fine", "passed")]);
    const base = fileReport("failed", [test_("x", "failed", WRONG_ANSWER), test_("still fine", "passed")]);

    expect(screenVerdict(thrice(classified([head], [base])))).toBe("keep");
  });

  it("a merge with no planned test has no hidden tests", () => {
    const none: Classification = { verdict: "no-tests", tests: [], files: [] };

    expect(screenVerdict(thrice(none))).toBe("no-hidden-tests");
  });

  it("a test that flips in one run is flaky", () => {
    expect(screenVerdict([classified([passing]), classified([failingOnHead]), classified([passing])])).toBe("flaky");
  });

  it("a test missing from one run is flaky", () => {
    const both = fileReport("passed", [test_("x", "passed"), test_("x2", "passed")]);
    const base = fileReport("failed", [test_("x", "failed", WRONG_ANSWER), test_("x2", "failed", WRONG_ANSWER)]);

    expect(screenVerdict([classified([both], [base]), classified([passing], [base]), classified([both], [base])])).toBe("flaky");
  });

  it("one of two same-named tests missing from a run is flaky", () => {
    const twice = fileReport("passed", [test_("x", "passed"), test_("x", "passed")]);
    const base = fileReport("failed", [test_("x", "failed", WRONG_ANSWER), test_("x", "failed", WRONG_ANSWER)]);

    expect(screenVerdict([classified([twice], [base]), classified([passing], [base]), classified([twice], [base])])).toBe("flaky");
  });

  it("a file that fails to load in one run is flaky, not a failure of the accepted merge", () => {
    expect(screenVerdict([classified([passing]), classified([loadError]), classified([passing])])).toBe("flaky");
  });

  it("a file of declined tests in one run and a load error in another is flaky", () => {
    const declined = fileReport("passed", [test_("x", "todo")]);

    expect(screenVerdict([classified([declined]), classified([loadError]), classified([declined])])).toBe("flaky");
  });

  it("the same tests reported in another order are not flaky", () => {
    const base = fileReport("failed", [test_("x", "failed", WRONG_ANSWER), test_("x2", "failed", WRONG_ANSWER)]);
    const forward = fileReport("passed", [test_("x", "passed"), test_("x2", "passed")]);
    const backward = fileReport("passed", [test_("x2", "passed"), test_("x", "passed")]);

    expect(screenVerdict([classified([forward], [base]), classified([backward], [base]), classified([forward], [base])])).toBe("keep");
  });

  it("a test head skips in only one run is flaky", () => {
    const skipped = fileReport("passed", [test_("x", "skipped")]);

    expect(screenVerdict([classified([passing]), classified([skipped]), classified([passing])])).toBe("flaky");
  });

  it("every run failing is fails-on-accepted", () => {
    expect(screenVerdict(thrice(classified([failingOnHead])))).toBe("fails-on-accepted");
  });

  it("one test failing in every run beside a reproducing one is fails-on-accepted", () => {
    const head = fileReport("failed", [test_("x", "passed"), test_("always red", "failed", WRONG_ANSWER)]);
    const base = fileReport("failed", [test_("x", "failed", WRONG_ANSWER), test_("always red", "failed", WRONG_ANSWER)]);

    expect(screenVerdict(thrice(classified([head], [base])))).toBe("fails-on-accepted");
  });

  it("a selected file failing to load at head in every run is fails-on-accepted", () => {
    expect(screenVerdict(thrice(classified([loadError])))).toBe("fails-on-accepted");
  });

  it("a head hook failure in every run is fails-on-accepted", () => {
    const hook = fileReport("failed", [test_("x", "pending")]);

    expect(screenVerdict(thrice(classified([hook])))).toBe("fails-on-accepted");
  });

  it("every test passing on base is vacuous", () => {
    expect(screenVerdict(thrice(classified([passing], [passing])))).toBe("vacuous");
  });

  it("a file whose every test head declines is vacuous", () => {
    const declined = fileReport("passed", [test_("x", "todo")]);

    expect(screenVerdict(thrice(classified([declined])))).toBe("vacuous");
  });

  it("a declined test beside a reproducing one keeps the case", () => {
    const head = fileReport("passed", [test_("x", "passed"), test_("later", "todo")]);

    expect(screenVerdict(thrice(classified([head])))).toBe("keep");
  });

  it("a new-api-only case is kept", () => {
    const base = fileReport("failed", [test_("x", "failed", NO_EXPORT)]);

    expect(screenVerdict(thrice(classified([passing], [base])))).toBe("keep");
  });

  it("a base load error reads as new-api and keeps the case", () => {
    expect(screenVerdict(thrice(classified([passing], [loadError])))).toBe("keep");
  });

  it("an error report drops the case with its message", () => {
    const broken: Classification = { verdict: "error", tests: [], files: [], error: "head: build failed (exit 3)" };

    expect(screenVerdict([classified([passing]), broken, classified([passing])])).toBe("screen-error:head: build failed (exit 3)");
  });

  it("a base hook failure drops the case with its message, since base cannot speak for the test", () => {
    const hook = fileReport("failed", [test_("x", "pending")]);

    expect(screenVerdict(thrice(classified([passing], [hook])))).toMatch(/^screen-error:base: a hook failed/);
  });

  it("no selected file at head is not-collected", () => {
    expect(screenVerdict(thrice(classified([], [failingOnBase])))).toBe("not-collected");
  });

  it("one selected file missing at head is not-collected", () => {
    expect(screenVerdict(thrice(classified([passing], [failingOnBase], [FILE, OTHER])))).toBe("not-collected");
  });

  it("no selected file at base is not-collected", () => {
    expect(screenVerdict(thrice(classified([passing], [])))).toBe("not-collected");
  });

  it("a test head skips though base passed it is not-collected, not vacuous", () => {
    const skipped = fileReport("passed", [test_("x", "skipped")]);

    expect(screenVerdict(thrice(classified([skipped], [passing])))).toBe("not-collected");
  });

  it("a test base skipped beside a reproducing one is not-collected", () => {
    const head = fileReport("passed", [test_("x", "passed"), test_("base skips", "passed")]);
    const base = fileReport("failed", [test_("x", "failed", WRONG_ANSWER), test_("base skips", "skipped")]);

    expect(screenVerdict(thrice(classified([head], [base])))).toBe("not-collected");
  });
});

describe("screenCase", { timeout: 60_000 }, () => {
  let root: string;
  let clone: string;
  let out: string;
  let pr: MergedPr;

  interface Call {
    file: string;
    args: readonly string[];
    cwd: string;
    timeoutMs: number;
  }

  /** Real git; every `sh` is the fake toolchain, and each vitest call on the head side takes the next entry of headRuns. */
  function fakeToolchain(headRuns: Report[], build = 0): { exec: Exec; calls: Call[] } {
    const calls: Call[] = [];
    const pending = [...headRuns];
    const exec: Exec = async (file, args, options) => {
      calls.push({ file, args, ...options });
      if (file !== "sh") return spawnExec(file, args, options);
      const at = args.indexOf("--outputFile");
      if (at === -1) return { status: build, stdout: "", stderr: "" };
      const report = options.cwd.endsWith("/head") ? pending.shift() : failingOnBase;
      writeFileSync(args[at + 1] ?? "", JSON.stringify({ testResults: [{ ...report, name: join(options.cwd, FILE) }] }));
      return { status: 0, stdout: "", stderr: "" };
    };
    return { exec, calls };
  }

  const source = (overrides: Partial<ImplementTaskSource> = {}): ImplementTaskSource => ({
    repo: "owner/titan-platform",
    pr: 42,
    baseSha: pr.base,
    mergeSha: pr.merge,
    brief: "Add x.",
    taskInitiative: null,
    cls: "local-fix",
    ...overrides,
  });
  const options = (exec: Exec) => ({ outDir: out, cloneFor: () => clone, exec });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "implement-screen-"));
    clone = join(root, "clone");
    out = join(root, "out");
    mkdirSync(clone);
    pr = buildMergedPr(clone);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("three stable runs of an accepted merge keep the case", async () => {
    const { exec } = fakeToolchain([passing, passing, passing]);

    expect(await screenCase(source(), options(exec))).toBe("keep");
  });

  it("a flip in the third head run reaches the verdict", async () => {
    const { exec } = fakeToolchain([passing, passing, failingOnHead]);

    expect(await screenCase(source(), options(exec))).toBe("flaky");
  });

  it("an error report drops the case with its message", async () => {
    const { exec } = fakeToolchain([], 3);

    expect(await screenCase(source(), options(exec))).toBe("screen-error:base: build failed (exit 3)");
  });

  it("a repo with no local clone drops the case without running anything", async () => {
    const { exec, calls } = fakeToolchain([]);

    expect(await screenCase(source(), { ...options(exec), cloneFor: () => undefined })).toBe("screen-error:no local clone for owner/titan-platform");
    expect(calls).toEqual([]);
  });

  it("a repo name that climbs out of the scratch dir drops the case before any clone", async () => {
    const { exec, calls } = fakeToolchain([]);

    expect(await screenCase(source({ repo: "../outside" }), options(exec))).toMatch(/^screen-error:repo is not owner\/name/);
    expect(calls).toEqual([]);
  });

  it("the scratch clone sits under out, the source clone gets no worktree, and no exec call is gh", async () => {
    const { exec, calls } = fakeToolchain([passing, passing, passing, passing, passing, passing]);
    const worktreesBefore = git(clone, "worktree", "list");

    await screenCase(source(), options(exec));
    await screenCase(source({ pr: 43 }), options(exec));

    const clones = calls.filter((call) => call.file === "git" && call.args.includes("clone"));
    expect(clones.map((call) => call.args)).toEqual([["clone", "--quiet", "--shared", "--no-checkout", "--", clone, join(out, ".scratch", "owner/titan-platform")]]);
    expect(git(join(out, ".scratch", "owner/titan-platform"), "rev-parse", "--is-bare-repository")).toBe("false");
    expect(git(clone, "worktree", "list")).toBe(worktreesBefore);
    expect(calls.map((call) => call.file).filter((file) => file !== "git" && file !== "sh")).toEqual([]);
  });

  it("each case gets one base build, one head build and three head runs inside the 30-minute budget, with no sandbox", async () => {
    const { exec, calls } = fakeToolchain([passing, passing, passing]);

    await screenCase(source(), options(exec));

    const runs = calls.filter((call) => call.file === "sh");
    const vitest = runs.filter((call) => call.args.includes("--outputFile"));
    expect(runs.length - vitest.length).toBe(2);
    expect(vitest.filter((call) => call.cwd.endsWith("/head"))).toHaveLength(3);
    expect(vitest.filter((call) => call.cwd.endsWith("/base"))).toHaveLength(2);
    expect(Math.max(...vitest.map((call) => call.timeoutMs))).toBeGreaterThan(SCREEN_BUDGET_MS - 60_000);
  });
});
