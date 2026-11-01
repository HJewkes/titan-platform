import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyReports, spawnExec, type Classification, type Exec, type FixProofPlan } from "@titan-design/fix-proof";
import { gitIn } from "@titan-design/test-kit/git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localCloneGit } from "../review-pr/bundle.js";
import { buildCorrectedRef, fixTests } from "./later-fix.js";
import { laterFixVerdict, screenLaterFix, type LaterFixScreenInput } from "./later-fix-screen.js";
import type { HeadRuns, screenCase } from "./screen.js";
import { buildMergedPr, type MergedPr } from "./test-fixture.js";
import type { ImplementTaskSource } from "./write-case.js";

const FILE = "src/bug.test.ts";
const WRONG_ANSWER = "AssertionError: expected 1 to be 2";
const NO_EXPORT = "TypeError: fix is not a function";

type Report = Record<string, unknown>;

const test_ = (fullName: string, status: string, failure?: string): Report => ({ fullName, status, failureMessages: failure === undefined ? [] : [failure] });
const fileReport = (status: string, tests: Report[]): Report => ({ name: `/${FILE}`, status, assertionResults: tests });

const passing = fileReport("passed", [test_("bug", "passed")]);
const wrongAnswer = fileReport("failed", [test_("bug", "failed", WRONG_ANSWER)]);
const missingExport = fileReport("failed", [test_("bug", "failed", NO_EXPORT)]);

function classified(head: Report, base: Report = wrongAnswer): Classification {
  return classifyReports({ selected: [FILE], base: { root: "/", report: { testResults: [base] } }, head: { root: "/", report: { testResults: [head] } } });
}

const thrice = (run: Classification): HeadRuns => [run, run, run];

describe("laterFixVerdict", () => {
  it("three agreeing runs with a test that fails on the accepted merge attach the fix", () => {
    expect(laterFixVerdict(thrice(classified(passing)))).toBe("attach");
  });

  it("a reproducing test beside a new-api one attaches the fix", () => {
    const head = fileReport("passed", [test_("bug", "passed"), test_("api", "passed")]);
    const base = fileReport("failed", [test_("bug", "failed", WRONG_ANSWER), test_("api", "failed", NO_EXPORT)]);

    expect(laterFixVerdict(thrice(classified(head, base)))).toBe("attach");
  });

  it("a fix whose only discriminating test is new-api needs a new API, though the primary screen would keep it", () => {
    expect(laterFixVerdict(thrice(classified(passing, missingExport)))).toBe("needs-new-api");
  });

  it("tests that already pass on the accepted merge pass on accepted", () => {
    expect(laterFixVerdict(thrice(classified(passing, passing)))).toBe("passes-on-accepted");
  });

  it("a test that flips in the third run only is flaky", () => {
    expect(laterFixVerdict([classified(passing), classified(passing), classified(wrongAnswer)])).toBe("flaky");
  });

  it("a test failing on the corrected reference in every run fails on corrected", () => {
    expect(laterFixVerdict(thrice(classified(wrongAnswer)))).toBe("fails-on-corrected");
  });

  it("an error report rejects the fix with its message", () => {
    const broken: Classification = { verdict: "error", tests: [], files: [], error: "head: build failed (exit 3)" };

    expect(laterFixVerdict(thrice(broken))).toBe("screen-error:head: build failed (exit 3)");
  });
});

const caseSource: ImplementTaskSource = { repo: "owner/widgets", pr: 3, baseSha: "b".repeat(40), mergeSha: "m".repeat(40), brief: "Add x.", taskInitiative: null, cls: "local-fix" };
const planOf = (tests: string[]): FixProofPlan => ({ tests, carried: [], overlayRemovals: [] }) as unknown as FixProofPlan;

function fakeScreen(runs: HeadRuns, plan = planOf([FILE])): { screen: typeof screenCase; calls: { source: ImplementTaskSource; clone: string | undefined }[] } {
  const calls: { source: ImplementTaskSource; clone: string | undefined }[] = [];
  const screen: typeof screenCase = async (source, options) => {
    calls.push({ source, clone: options.cloneFor(source.repo) });
    options.onRuns?.(plan, runs);
    return "keep";
  };
  return { screen, calls };
}

const input = (overrides: Partial<LaterFixScreenInput>): LaterFixScreenInput => ({
  source: caseSource,
  fixPr: 5,
  correctedSha: "c".repeat(40),
  tests: [FILE],
  clone: "/scratch/owner/widgets",
  outDir: "/out",
  ...overrides,
});

describe("screenLaterFix", () => {
  it("screens the accepted merge as base and the corrected reference as head in the scratch clone", async () => {
    const { screen, calls } = fakeScreen(thrice(classified(passing)));

    expect(await screenLaterFix(input({ screen }))).toBe("attach");
    expect(calls).toEqual([{ source: { ...caseSource, pr: 5, baseSha: "m".repeat(40), mergeSha: "c".repeat(40) }, clone: "/scratch/owner/widgets" }]);
  });

  it("a screen that planned other tests than the fix's rejects plan-mismatch", async () => {
    const { screen } = fakeScreen(thrice(classified(passing)), planOf([FILE, "src/other.test.ts"]));

    expect(await screenLaterFix(input({ screen }))).toBe("plan-mismatch");
  });

  it("a screen that throws rejects the fix with its message", async () => {
    const screen: typeof screenCase = async () => {
      throw new Error("disk full");
    };

    expect(await screenLaterFix(input({ screen }))).toBe("screen-error:disk full");
  });

  it("a screen that fails before judging any run passes its error through", async () => {
    const screen: typeof screenCase = async () => "screen-error:no local clone for owner/widgets";

    expect(await screenLaterFix(input({ screen }))).toBe("screen-error:no local clone for owner/widgets");
  });
});

describe("screenLaterFix over a temp repo", { timeout: 60_000 }, () => {
  let root: string;
  let out: string;
  let scratch: string;
  let accepted: MergedPr;
  let fix: { base: string; merge: string };

  function writeFix(clone: string): { base: string; merge: string } {
    const run = gitIn(clone);
    const base = run("rev-parse", "HEAD");
    run("checkout", "-q", "-b", "fix");
    writeFileSync(join(clone, "src/x.ts"), "export const x = 3;\n");
    writeFileSync(join(clone, FILE), "it('bug', () => {});\n");
    run("add", "-A");
    run("commit", "-q", "-m", "fix x");
    run("checkout", "-q", "main");
    run("merge", "-q", "--no-ff", "-m", "Merge fix", "fix");
    return { base, merge: run("rev-parse", "HEAD") };
  }

  /** Real git; every `sh` is the fake toolchain: base reports an assertion failure, head a pass. */
  function fakeToolchain(): { exec: Exec; vitestCwds: string[]; trees: string[][] } {
    const vitestCwds: string[] = [];
    const trees: string[][] = [];
    const exec: Exec = async (file, args, options) => {
      if (file === "git" && args.includes("worktree") && args.includes("add")) trees.push([...args]);
      if (file !== "sh") return spawnExec(file, args, options);
      const at = args.indexOf("--outputFile");
      if (at === -1) return { status: 0, stdout: "", stderr: "" };
      vitestCwds.push(options.cwd);
      const report = options.cwd.endsWith("/head") ? passing : wrongAnswer;
      writeFileSync(args[at + 1] ?? "", JSON.stringify({ testResults: [{ ...report, name: join(options.cwd, FILE) }] }));
      return { status: 0, stdout: "", stderr: "" };
    };
    return { exec, vitestCwds, trees };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "later-fix-screen-"));
    const clone = join(root, "clone");
    out = join(root, "out");
    scratch = join(out, ".scratch", caseSource.repo);
    mkdirSync(clone);
    accepted = buildMergedPr(clone);
    fix = writeFix(clone);
    mkdirSync(join(out, ".scratch", "owner"), { recursive: true });
    gitIn(root)("clone", "--quiet", "--shared", "--no-checkout", "--", clone, scratch);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("attaches a fix whose test fails on the accepted merge, after three head runs of the corrected reference", async () => {
    const { exec, vitestCwds, trees } = fakeToolchain();
    const corrected = await buildCorrectedRef({ clone: scratch, scratchDir: join(out, ".later-fix"), merge: accepted.merge, fixPr: 5, fixBase: fix.base, fixMerge: fix.merge, exec: spawnExec });
    const planned = await fixTests(localCloneGit(scratch), fix.base, fix.merge);
    if (!corrected.ok || !planned.ok) throw new Error("fixture: the fix must apply and change a test");
    const source = { ...caseSource, baseSha: accepted.base, mergeSha: accepted.merge };

    const verdict = await screenLaterFix({ source, fixPr: 5, correctedSha: corrected.sha, tests: planned.tests, clone: scratch, outDir: out, exec });

    expect(verdict).toBe("attach");
    expect(trees.map((args) => args.at(-1))).toEqual([accepted.merge, corrected.sha]);
    expect(vitestCwds.filter((cwd) => cwd.endsWith("/head"))).toHaveLength(3);
  });
});
