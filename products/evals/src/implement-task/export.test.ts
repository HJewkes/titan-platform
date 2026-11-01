import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyReports, spawnExec, type Classification, type Exec } from "@titan-design/fix-proof";
import { seedRepo, withHistory } from "@titan-design/test-kit/git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { caseHash } from "../hash.js";
import { defaultPolicy, type ExclusionPolicy } from "../private/exclusion.js";
import { EvalCaseSchema, SuiteSpecSchema } from "../spec/index.js";
import { localCloneGit } from "../review-pr/bundle.js";
import { validateSpec } from "../validate.js";
import { exportImplementTaskCases, selectExportPool, type ExportOptions } from "./export.js";
import type { CorpusV3Row } from "./select.js";
import type { HeadRuns, screenCase } from "./screen.js";
import { planHiddenTests, type ImplementTaskSource } from "./write-case.js";

const PRIVATE_SLUG = "household-ledger";

let root: string;
let clone: string;
let out: string;
let policy: ExclusionPolicy;

interface MergedPr {
  base: string;
  merge: string;
}

/** A squash merge on a lockfile repo: the selector refuses a two-parent merge and a repo with no supported lockfile. */
function setUp(extra: Record<string, string> = {}, atBase: Record<string, string> = {}): MergedPr {
  seedRepo(clone, {});
  const [base = "", merge = ""] = withHistory(clone, [
    { message: "base", files: { "pnpm-lock.yaml": "lockfileVersion: 9\n", "src/a.ts": "export const a = 1;\n", ...atBase } },
    { message: "squash", files: { "src/x.ts": "export const x = 2;\n", "src/x.test.ts": "it('x', () => {});\n", ...extra } },
  ]);
  return { base, merge };
}

function row(pr: MergedPr, number: number, overrides: Partial<CorpusV3Row> = {}): CorpusV3Row {
  return {
    case_id: `titan-platform#${number}`,
    repo: "titan-platform",
    pr_number: number,
    base_commit: pr.base,
    merge_commit: pr.merge,
    class: "local-fix",
    n_tasks: 1,
    task_ids: [],
    task: null,
    title: "Add x",
    brief_text: "Add x. Done when x is exported.",
    follow_up_fixes: [],
    ...overrides,
  };
}

function corpus(rows: readonly CorpusV3Row[]): string {
  const path = join(root, "corpus.jsonl");
  writeFileSync(path, rows.map((entry) => JSON.stringify(entry)).join("\n"));
  return path;
}

interface FakeScreen {
  screen: (source: ImplementTaskSource) => Promise<string>;
  calls: number[];
}

/** Verdicts by PR number, keep by default; each call also records whether a case was already on disk. */
function fakeScreen(verdicts: Record<number, string> = {}): FakeScreen {
  const calls: number[] = [];
  return {
    calls,
    screen: async (source) => {
      expect(existsSync(join(out, "cases"))).toBe(false);
      calls.push(source.pr);
      return verdicts[source.pr] ?? "keep";
    },
  };
}

function optionsFor(rows: readonly CorpusV3Row[], overrides: Partial<ExportOptions> = {}): ExportOptions {
  return { corpus: corpus(rows), outDir: out, policy, cloneFor: () => clone, classes: ["local-fix", "feature-slice"], perClass: 1, seed: "test", log: () => undefined, ...overrides };
}

const readJson = (name: string): unknown => JSON.parse(readFileSync(join(out, name), "utf8"));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "implement-export-"));
  clone = join(root, "clone");
  out = join(root, "out");
  const activeWorkRoot = join(root, "active-work");
  mkdirSync(join(activeWorkRoot, PRIVATE_SLUG, "tasks"), { recursive: true });
  writeFileSync(join(activeWorkRoot, PRIVATE_SLUG, "brief.md"), "# private\n");
  writeFileSync(join(activeWorkRoot, PRIVATE_SLUG, "tasks", "HL-7.yml"), "id: HL-7\n");
  policy = defaultPolicy(activeWorkRoot);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("exportImplementTaskCases", () => {
  it("one case per class at per-class 1, and screening stops at quota", async () => {
    const pr = setUp();
    const rows = [1, 2, 3].map((n) => row(pr, n)).concat([4, 5].map((n) => row(pr, n, { class: "feature-slice" })));
    const fake = fakeScreen();

    const manifest = await exportImplementTaskCases(optionsFor(rows, { screen: fake.screen }));

    expect(fake.calls).toHaveLength(2);
    expect(readdirSync(join(out, "cases"))).toHaveLength(2);
    expect(manifest.counts).toEqual({
      "local-fix": { kept: 1, screened: 1, unscreened: 2, shortfall: 0 },
      "feature-slice": { kept: 1, screened: 1, unscreened: 1, shortfall: 0 },
    });
  });

  it("no case is written before its screen", async () => {
    const pr = setUp();
    const fake = fakeScreen({ 1: "flaky" });

    await exportImplementTaskCases(optionsFor([row(pr, 1)], { screen: fake.screen }));

    expect(fake.calls).toEqual([1]);
    expect(existsSync(join(out, "cases"))).toBe(false);
    expect(existsSync(join(out, "trees"))).toBe(false);
  });

  it("a private brief is never screened", async () => {
    const pr = setUp();
    const fake = fakeScreen();
    const rows = [row(pr, 1, { brief_text: `Budget per active-work/${PRIVATE_SLUG}/brief.md` })];

    const manifest = await exportImplementTaskCases(optionsFor(rows, { screen: fake.screen }));

    expect(fake.calls).toEqual([]);
    expect(manifest.excluded).toEqual({ "private-marker": 1 });
  });

  it("a hidden test path naming a private task is excluded before its screen, not refused after it", async () => {
    const pr = setUp({ "src/HL-7.test.ts": "it('hl', () => {});\n" });
    const fake = fakeScreen();

    const manifest = await exportImplementTaskCases(optionsFor([row(pr, 1)], { screen: fake.screen }));

    expect(fake.calls).toEqual([]);
    expect(manifest.excluded).toEqual({ "private-marker": 1 });
  });

  it("a class that runs out of candidates reports its shortfall", async () => {
    const pr = setUp();
    const fake = fakeScreen({ 2: "vacuous" });

    const manifest = await exportImplementTaskCases(optionsFor([row(pr, 1), row(pr, 2)], { screen: fake.screen, perClass: 3 }));

    expect(manifest.counts["local-fix"]).toEqual({ kept: 1, screened: 2, unscreened: 0, shortfall: 2 });
    expect(manifest.counts["feature-slice"]).toEqual({ kept: 0, screened: 0, unscreened: 0, shortfall: 3 });
  });

  it("dropped cases are listed with reasons", async () => {
    const pr = setUp();
    const fake = fakeScreen({ 1: "flaky", 2: "screen-error:creating the base worktree failed (exit 1)" });

    const manifest = await exportImplementTaskCases(optionsFor([row(pr, 1), row(pr, 2)], { screen: fake.screen, perClass: 2 }));

    expect(manifest.dropped).toHaveLength(2);
    expect(manifest.dropped).toEqual(expect.arrayContaining([
      { repo: "HJewkes/titan-platform", pr: 1, cls: "local-fix", reason: "flaky" },
      { repo: "HJewkes/titan-platform", pr: 2, cls: "local-fix", reason: "screen-error:creating the base worktree failed (exit 1)" },
    ]));
    expect(readJson("manifest.json")).toEqual(manifest);
  });

  it("suite.json passes strict validateSpec", async () => {
    const pr = setUp();

    const manifest = await exportImplementTaskCases(optionsFor([row(pr, 1)], { screen: fakeScreen().screen }));

    const raw = readJson("suite.json");
    const validated = await validateSpec(raw, () => Promise.reject(new Error("the suite names no prompt")));
    const suite = SuiteSpecSchema.parse(raw);
    const [file = ""] = readdirSync(join(out, "cases"));
    const written = EvalCaseSchema.parse(JSON.parse(readFileSync(join(out, "cases", file), "utf8")));
    expect(validated.hash).toBe(manifest.suite);
    expect(suite.id).toBe("implement-task-private");
    expect(suite.checks).toEqual([]);
    expect(suite.cases).toEqual([caseHash(written)]);
  });

  it("a candidate whose screen throws is dropped and the next one fills the class", async () => {
    const pr = setUp();
    const fake = fakeScreen();
    const seen: number[] = [];
    const screen = async (source: ImplementTaskSource) => {
      seen.push(source.pr);
      if (seen.length === 1) throw new Error("install failed at an old commit");
      return fake.screen(source);
    };

    const manifest = await exportImplementTaskCases(optionsFor([row(pr, 1), row(pr, 2)], { screen }));

    expect(seen).toHaveLength(2);
    expect(manifest.dropped).toEqual([{ repo: "HJewkes/titan-platform", pr: seen[0], cls: "local-fix", reason: "screen-error:install failed at an old commit" }]);
    expect(manifest.counts["local-fix"]).toEqual({ kept: 1, screened: 2, unscreened: 0, shortfall: 0 });
    expect(readdirSync(join(out, "cases"))).toHaveLength(1);
  });

  it("a candidate whose facts cannot be read is dropped unscreened and the next one is screened", async () => {
    const pr = setUp();
    const fake = fakeScreen();
    const rows = [row(pr, 1, { merge_commit: "f".repeat(40) }), row(pr, 2)];

    const manifest = await exportImplementTaskCases(optionsFor(rows, { screen: fake.screen }));

    expect(fake.calls).toEqual([2]);
    expect(manifest.dropped).toEqual([{ repo: "HJewkes/titan-platform", pr: 1, cls: "local-fix", reason: expect.stringMatching(/^screen-error:/) }]);
  });

  it("a candidate whose fix-proof plan fails is dropped unscreened with the plan's message", async () => {
    const pr = setUp({}, { ".github/fix-proof.json": "not json" });
    const fake = fakeScreen();

    const manifest = await exportImplementTaskCases(optionsFor([row(pr, 1)], { screen: fake.screen }));

    expect(fake.calls).toEqual([]);
    expect(manifest.dropped).toEqual([{ repo: "HJewkes/titan-platform", pr: 1, cls: "local-fix", reason: expect.stringMatching(/^screen-error:fix-proof plan for /) }]);
  });

  it("a failed candidate with a private brief is excluded, not listed", async () => {
    const pr = setUp();
    const rows = [row(pr, 1, { merge_commit: "f".repeat(40), brief_text: `Budget per active-work/${PRIVATE_SLUG}/brief.md` })];

    const manifest = await exportImplementTaskCases(optionsFor(rows, { screen: fakeScreen().screen }));

    expect(manifest.dropped).toEqual([]);
    expect(manifest.excluded).toEqual({ "private-marker": 1 });
  });

  it("scratch is gone after a throwing screen", async () => {
    const pr = setUp();
    const screen = async () => {
      mkdirSync(join(out, ".scratch", "owner", "repo"), { recursive: true });
      throw new Error("install failed");
    };

    const manifest = await exportImplementTaskCases(optionsFor([row(pr, 1)], { screen }));

    expect(manifest.dropped).toHaveLength(1);
    expect(existsSync(join(out, ".scratch"))).toBe(false);
  });

  it("scratch is gone after the run itself aborts", async () => {
    const pr = setUp();
    const screen = async () => {
      mkdirSync(join(out, ".scratch", "owner", "repo"), { recursive: true });
      return "keep";
    };
    const log = () => {
      throw new Error("stderr closed");
    };

    await expect(exportImplementTaskCases(optionsFor([row(pr, 1)], { screen, log }))).rejects.toThrow("stderr closed");

    expect(existsSync(join(out, ".scratch"))).toBe(false);
  });

  it("aborts on an unreadable corpus", async () => {
    await expect(exportImplementTaskCases(optionsFor([], { corpus: join(root, "missing.jsonl") }))).rejects.toThrow(/ENOENT/);
  });

  it("records the corpus digest, a later fix PR missing from the corpus and skips by reason in the manifest", async () => {
    const pr = setUp();
    const rows = [row(pr, 1, { follow_up_fixes: [9] }), row(pr, 2, { repo: PRIVATE_SLUG, case_id: `${PRIVATE_SLUG}#2` })];
    const options = optionsFor(rows, { screen: fakeScreen().screen });

    const manifest = await exportImplementTaskCases(options);

    expect(manifest.corpusSha256).toBe(createHash("sha256").update(readFileSync(options.corpus)).digest("hex"));
    expect(manifest.laterFix).toEqual({
      attached: [],
      rejected: [{ caseId: expect.stringMatching(/-pr1-implement-/), pr: 9, fixSource: "follow-up", reason: "fix-not-in-corpus" }],
      counts: { attached: 0, rejected: { "fix-not-in-corpus": 1 } },
    });
    expect(manifest.skipped).toEqual({ "private-repo": 1 });
    expect(JSON.stringify(manifest)).not.toContain(PRIVATE_SLUG);
  });

  it("refuses an out dir that already holds files, before reading the corpus", async () => {
    mkdirSync(out);
    writeFileSync(join(out, "stale.json"), "{}\n");

    await expect(exportImplementTaskCases(optionsFor([]))).rejects.toThrow(/is not empty/);
  });
});

describe("selectExportPool", () => {
  it("qualifies a bare corpus repo and caps each class at max candidates", async () => {
    const pr = setUp();

    const pool = await selectExportPool(optionsFor([row(pr, 1), row(pr, 2), row(pr, 3)], { maxCandidates: 2 }));

    expect(pool.byClass["local-fix"]?.map((source) => source.repo)).toEqual(["HJewkes/titan-platform", "HJewkes/titan-platform"]);
  });

  it("prefixes a bare corpus repo with the owner option", async () => {
    const pr = setUp();
    const asked: string[] = [];
    const cloneFor = (repo: string) => {
      asked.push(repo);
      return clone;
    };

    const pool = await selectExportPool(optionsFor([row(pr, 1)], { cloneFor, owner: "someone-else" }));

    expect(pool.byClass["local-fix"]?.map((source) => source.repo)).toEqual(["someone-else/titan-platform"]);
    expect(asked).toContain("someone-else/titan-platform");
  });

  it("leaves out a repo with no clone and names it", async () => {
    const pr = setUp();

    const pool = await selectExportPool(optionsFor([row(pr, 1), row(pr, 2, { repo: "relay" })], { cloneFor: (repo) => (repo.endsWith("/titan-platform") ? clone : undefined) }));

    expect(pool.byClass["local-fix"]?.map((source) => source.pr)).toEqual([1]);
    expect(pool.reposWithoutClone).toContain("relay");
  });
});

const BUG_TEST = "src/bug.test.ts";
const BUG_TEST_TEXT = "it('bug', () => expect(x).toBe(3));\n";

interface LaterFixHistory {
  accepted: MergedPr;
  /** Adds the bug test and fixes x on top of the accepted merge. */
  f1: MergedPr;
  /** Edits a line an intervening commit changed after the accepted merge, so its diff does not apply to it. */
  f2: MergedPr;
}

/** B, the accepted squash M, F1 on M, an intervening commit I, then F2 on I; all on main. */
function setUpLaterFixes(): LaterFixHistory {
  seedRepo(clone, {});
  const [base = "", merge = "", f1 = "", between = "", f2 = ""] = withHistory(clone, [
    { message: "base", files: { "pnpm-lock.yaml": "lockfileVersion: 9\n", "src/a.ts": "export const a = 1;\n" } },
    { message: "squash", files: { "src/x.ts": "export const x = 2;\n", "src/x.test.ts": "it('x', () => {});\n" } },
    { message: "fix x", files: { "src/x.ts": "export const x = 3;\n", [BUG_TEST]: BUG_TEST_TEXT } },
    { message: "bump a", files: { "src/a.ts": "export const a = 10;\n" } },
    { message: "fix a", files: { "src/a.ts": "export const a = 11;\n", "src/a.test.ts": "it('a', () => {});\n" } },
  ]);
  return { accepted: { base, merge }, f1: { base: merge, merge: f1 }, f2: { base: between, merge: f2 } };
}

function laterFixRows(history: LaterFixHistory, caseOverrides: Partial<CorpusV3Row> = {}): CorpusV3Row[] {
  const fixRow = (pr: MergedPr, number: number) => row(pr, number, { class: "bug-fix", title: "Fix", brief_text: null });
  return [row(history.accepted, 1, { follow_up_fixes: [11, 12], ...caseOverrides }), fixRow(history.f1, 11), fixRow(history.f2, 12)];
}

type Report = Record<string, unknown>;
const fileReport = (status: string, failure?: string): Report => ({
  name: `/${BUG_TEST}`,
  status,
  assertionResults: [{ fullName: "bug", status, failureMessages: failure === undefined ? [] : [failure] }],
});

/** What a real screen judges for F1: an assertion failure on the accepted merge and a pass on the corrected reference. */
const reproducing = (): Classification =>
  classifyReports({ selected: [BUG_TEST], base: { root: "/", report: { testResults: [fileReport("failed", "AssertionError: expected 2 to be 3")] } }, head: { root: "/", report: { testResults: [fileReport("passed")] } } });

/** Plans from the clone it is handed, as the real screen does, and reports F1's judged runs. */
function fakeLaterScreen(): { screen: typeof screenCase; calls: ImplementTaskSource[] } {
  const calls: ImplementTaskSource[] = [];
  const screen: typeof screenCase = async (source, screenOptions) => {
    calls.push(source);
    const plan = await planHiddenTests(localCloneGit(screenOptions.cloneFor(source.repo) ?? ""), source.baseSha, source.mergeSha);
    const run = reproducing();
    screenOptions.onRuns?.(plan, [run, run, run] satisfies HeadRuns);
    return "keep";
  };
  return { screen, calls };
}

function recordingExec(): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (file, args, execOptions) => {
    calls.push([file, ...args]);
    return spawnExec(file, args, execOptions);
  };
  return { exec, calls };
}

const writtenCase = () => {
  const [file = ""] = readdirSync(join(out, "cases"));
  return EvalCaseSchema.parse(JSON.parse(readFileSync(join(out, "cases", file), "utf8")));
};

describe("exportImplementTaskCases with later fixes", { timeout: 60_000 }, () => {
  it("attaches the fix whose test reproduces and rejects the one that does not apply, never screening it", async () => {
    const history = setUpLaterFixes();
    const later = fakeLaterScreen();
    const { exec, calls } = recordingExec();

    const manifest = await exportImplementTaskCases(optionsFor(laterFixRows(history), { screen: fakeScreen().screen, laterFixScreen: later.screen, exec }));

    const written = writtenCase();
    const sha256 = createHash("sha256").update(BUG_TEST_TEXT).digest("hex");
    expect(written.expected).toMatchObject({ laterFixTests: [{ path: BUG_TEST, sha256, sourcePr: 11, sourceSha: history.f1.merge, fixSource: "follow-up" }], laterFixSupport: [] });
    expect(readFileSync(join(out, "hidden", written.id, "fix-11", BUG_TEST), "utf8")).toBe(BUG_TEST_TEXT);
    expect(existsSync(join(out, "hidden", written.id, "fix-12"))).toBe(false);
    expect(later.calls.map((source) => [source.pr, source.baseSha])).toEqual([[11, history.accepted.merge]]);
    expect(manifest.laterFix).toEqual({
      attached: [{ caseId: written.id, pr: 11, fixSource: "follow-up", tests: [BUG_TEST] }],
      rejected: [{ caseId: written.id, pr: 12, fixSource: "follow-up", reason: "fix-not-applicable" }],
      counts: { attached: 1, rejected: { "fix-not-applicable": 1 } },
    });
    expect(calls.some(([file, ...args]) => file === "git" && args.includes("clone"))).toBe(true);
    expect(calls.flat()).not.toContain("gh");
    expect(calls.filter((args) => args[1] === "-C" && args[2] === clone)).toEqual([]);
  });

  it("with later fixes off, writes the case without later-fix tests and screens no fix", async () => {
    const history = setUpLaterFixes();
    const later = fakeLaterScreen();

    const manifest = await exportImplementTaskCases(optionsFor(laterFixRows(history), { screen: fakeScreen().screen, laterFixScreen: later.screen, laterFixSource: "none" }));

    const written = writtenCase();
    expect(Object.keys(written.expected as object)).toEqual(["hiddenTests", "support", "overlayRemovals"]);
    expect(existsSync(join(out, "hidden", written.id, "fix-11"))).toBe(false);
    expect(later.calls).toEqual([]);
    expect(manifest).not.toHaveProperty("laterFix");
  });

  it("a case the primary screen drops never screens its later fixes", async () => {
    const history = setUpLaterFixes();
    const later = fakeLaterScreen();

    const manifest = await exportImplementTaskCases(optionsFor(laterFixRows(history), { screen: fakeScreen({ 1: "flaky" }).screen, laterFixScreen: later.screen }));

    expect(later.calls).toEqual([]);
    expect(manifest.laterFix?.counts).toEqual({ attached: 0, rejected: {} });
  });

  it("the fix-touch source ignores follow_up_fixes and records a fix both list under fix-touch", async () => {
    const history = setUpLaterFixes();
    const later = fakeLaterScreen();
    const rows = laterFixRows(history, { fix_touch_14d: [11] });

    const manifest = await exportImplementTaskCases(optionsFor(rows, { screen: fakeScreen().screen, laterFixScreen: later.screen, laterFixSource: "fix-touch" }));

    expect(later.calls.map((source) => source.pr)).toEqual([11]);
    expect(manifest.laterFix?.attached.map(({ pr, fixSource }) => [pr, fixSource])).toEqual([[11, "fix-touch"]]);
    expect(manifest.laterFix?.rejected).toEqual([]);
  });
});
