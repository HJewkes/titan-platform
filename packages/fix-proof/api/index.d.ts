export { LinearRegExp, linearRegExpSteps } from './linear-regexp.js';

/** Where a target repo keeps its fix-proof config; read at the merge base, never at head. */
declare const CONFIG_PATH = ".github/fix-proof.json";
declare const DEFAULT_TEST_GLOBS: readonly string[];
declare const DEFAULT_CARRY_GLOBS: readonly string[];
/**
 * Mutation specs sit next to their test as `<test file minus extension>.mutations.json`. A fixed glob, not a config key:
 * the config parser refuses unknown keys, so a key would fail every run whose merge base predates it. A new key needs
 * this parser on main before any config uses it; CI builds the parser from the merge-base tree, so ordering on main is
 * enough.
 */
declare const MUTATION_SPEC_GLOB = "**/*.mutations.json";
declare const CHANGESET_GLOB = ".changeset/*.md";
/**
 * On `pull_request` the PR merge ref supplies the workflow file and the run script, so a PR touching any of these
 * chose the code that printed its own result line. Each entry is a path prefix.
 */
declare const FIX_PROOF_HARNESS: readonly string[];
declare function isHarnessPath(path: string): boolean;
interface FixProofConfig {
    tests: string[];
    carry: string[];
    /**
     * Carry or test paths that ship or run in production, such as published fixtures. Never test-only: they read as
     * source, yet stay carried so the fix-proof overlay is unchanged.
     */
    runtime: string[];
    command?: string;
    build?: string;
}
type ConfigResult = {
    ok: true;
    config: FixProofConfig;
} | {
    ok: false;
    error: string;
};
/** Parses the config text found at the merge base; absent text gives the defaults. */
declare function parseFixProofConfig(text: string | null | undefined): ConfigResult;

/** Every alternative of a brace glob, innermost group first; throws past 256 alternatives, 32 brace groups or 1024 characters. */
declare function expandBraces(glob: string): string[];
/** A matcher for repo-relative POSIX paths supporting `**`, `*`, `?` and `{a,b}`, in time linear in the path. */
declare function compileGlobs(globs: readonly string[]): (path: string) => boolean;

interface PlanInput {
    /** Output of `git diff -M --name-status <mergeBase> <head>`. */
    nameStatus: string;
    /** `.github/fix-proof.json` at the merge base; null or absent when the file does not exist there. */
    baseConfig?: string | null;
    /** The same file at head, used only to tell the reviewer the PR edited it. */
    headConfig?: string | null;
    /**
     * Paths at head beside the diff's mutation specs. A spec whose one sibling test is listed here plans that test, so a
     * spec-only diff still runs the file its mutants are judged on; absent, no sibling is planned.
     */
    headFiles?: readonly string[];
}
interface FixProofPlan {
    /** Head paths of added or changed tests, to check out over the merge base and run. */
    tests: string[];
    /** Added or changed support files matching the carry globs. */
    carried: string[];
    /** Tests the PR deletes: never run, named to the reviewer. */
    deletedTests: string[];
    /** Old paths of partially renamed tests, removed from the overlay. */
    overlayRemovals: string[];
    /** Added or changed mutation specs, read at head by the mutants check. */
    mutations: string[];
    /**
     * Every changed or deleted path, both sides of a rename, that is a harness path or is not a test, a carried file, a
     * mutation spec or a changeset. Empty means the diff is test-only.
     */
    source: string[];
    config: FixProofConfig;
    configEdited: boolean;
}
type PlanResult = {
    ok: true;
    plan: FixProofPlan;
} | {
    ok: false;
    error: string;
};
/**
 * True when the diff touches only tests, carried files, mutation specs and changesets, none of them harness or runtime
 * paths. It ignores deleted tests and an empty `tests`; `testOnlyReading` refuses those too.
 */
declare function testOnlyOf(plan: Pick<FixProofPlan, "source">): boolean;
type TestOnlyReading = {
    testOnly: true;
} | {
    testOnly: false;
    reason: "source";
    paths: string[];
} | {
    testOnly: false;
    reason: "deletes-tests";
    paths: string[];
} | {
    testOnly: false;
    reason: "no-tests";
};
/**
 * Whether a diff is test-only, and if not why: it changes source (runtime paths included), it deletes a test (a rename
 * out of the tests counts), or it plans no test at all (a changeset- or fixture-only diff, or a spec with no sibling).
 */
declare function testOnlyReading(plan: Pick<FixProofPlan, "source" | "tests" | "deletedTests">): TestOnlyReading;
/** Splits a merge-base-to-head diff into tests to run, carried support files, deleted tests, mutation specs and source, using globs from the base config only. */
declare function planFixProof(input: PlanInput): PlanResult;

declare const MAX_MUTATIONS = 5;
declare const MAX_MUTATION_NAME = 80;
declare const MAX_MUTATION_EDIT = 400;
declare const MAX_KILLS = 20;
/** Five mutations at their field caps fit well under this; anything larger is not a spec a person wrote. */
declare const MAX_SPEC_BYTES: number;
/** One exact edit to a non-test file at the merge base, and the full vitest names of the tests it must fail. */
interface Mutation {
    name: string;
    file: string;
    find: string;
    replace: string;
    kills: string[];
}
/** A generated edit: a Mutation with no declared kills, since it proves nothing about a named test. */
type HeadMutation = Omit<Mutation, "kills">;
interface MutationSpec {
    v: 1;
    mutations: Mutation[];
}
type MutationSpecResult = {
    ok: true;
    spec: MutationSpec;
} | {
    ok: false;
    error: string;
};
type MutationCheck = {
    ok: true;
} | {
    ok: false;
    error: string;
};
/** Parses a `*.mutations.json` spec strictly: unknown keys, over-long fields and empty or duplicate kills are refused. */
declare function parseMutationSpec(text: string): MutationSpecResult;
/**
 * Whether one mutation can run against the merge base: its file must be code under test, not a test, carried file, spec or
 * harness path, and must exist there (`baseText` null means it does not) with `find` occurring exactly once. `at` names
 * the commit `baseText` came from in the error, for a caller that checks against another one.
 */
declare function checkMutation(mutation: HeadMutation, baseText: string | null, config: FixProofConfig, at?: string): MutationCheck;

/** `skipped` is a test the file chose not to run (`skip`, `skipIf`, `todo`) in a file that did not fail; anything else unrun is `other`. */
type TestStatus = "passed" | "failed" | "skipped" | "other";

/** Under GitHub's 1 MB per-job output limit, leaving room for the base job's second report. */
declare const MAX_ENCODED_BYTES = 900000;
declare const MAX_INFLATED_BYTES: number;
/** `reported` marks an error the exec side wrote itself, as opposed to a report that failed to arrive or decode. */
type DecodedReport = {
    ok: true;
    report: {
        testResults: unknown[];
    };
} | {
    ok: false;
    error: string;
    reported: boolean;
};
interface DecodeOptions {
    maxBytes?: number;
}
/** A vitest JSON report reduced to the fields the classifier reads, gzipped and base64-encoded: no space, no newline. */
declare function encodeReport(report: unknown): string;
/** An encoded marker saying this side produced no report, carrying why; the judge turns it into a verdict error. */
declare function encodeError(error: string): string;
/** Decodes one encoded report under an encoded and an inflated byte cap; anything missing, oversized or malformed is an error, never a throw. */
declare function decodeReport(text: string | undefined, options?: DecodeOptions): DecodedReport;
/** One mutation's run on the mutants side: `built` false means its rebuild failed and `report` is absent. */
interface MutantRun {
    spec: string;
    name: string;
    built: boolean;
    report?: unknown;
}
interface MutantsReport {
    /** The merge base with the head's tests overlaid, run once before any mutation. */
    baseline: unknown;
    runs: MutantRun[];
}
/** `skipped` marks a mutants side that chose not to run: no spec in the diff, or a diff with source paths. */
type DecodedMutants = {
    ok: true;
    skipped: string;
} | {
    ok: true;
    skipped?: undefined;
    baseline: {
        testResults: unknown[];
    };
    runs: MutantRun[];
} | {
    ok: false;
    error: string;
    reported: boolean;
};
/** The mutants side's one combined report: the baseline and each mutation's run, encoded like `encodeReport`. */
declare function encodeMutantsReport(report: MutantsReport): string;
/** An encoded marker saying the mutants side had nothing to run, carrying why. */
declare function encodeMutantsSkipped(reason: string): string;
/** Decodes the mutants side's report under the same caps as `decodeReport`; anything malformed is an error, never a throw. */
declare function decodeMutantsReport(text: string | undefined, options?: DecodeOptions): DecodedMutants;

/**
 * - `killed`: the mutant built and the tests failing under it, every one an assertion failure, are exactly its `kills`.
 * - `overkill`: every `kills` test failed, and so did another test.
 * - `survived`: some `kills` test did not fail.
 * - `unbuilt`: the rebuild under the mutation failed.
 * - `load-error`: the test file failed to load, or some test failed with a load or new-API error.
 * - `baseline`: a `kills` test did not pass exactly once in the unmutated baseline run. A kill naming no test in a
 *   baseline that loaded is no outcome but an `error` verdict naming the spec, mutation and kill.
 * - `error`: the mutation's run is missing from the report, or some test failed with anything but an assertion failure:
 *   a thrown TypeError, a timeout, a crash, or no failure message at all.
 */
declare const MUTANT_OUTCOMES: readonly ["killed", "overkill", "survived", "unbuilt", "load-error", "baseline", "error"];
type MutantOutcome = (typeof MUTANT_OUTCOMES)[number];
/**
 * `killed` only when every declared mutation is killed and every changed test file has a spec of its own in the diff,
 * except a carried test that loads only carried files;
 * `error` when the specs or the report could not be read at all.
 */
declare const MUTANT_VERDICTS: readonly ["killed", "not-killed", "error"];
type MutantVerdict = (typeof MUTANT_VERDICTS)[number];
interface MutantResult {
    spec: string;
    name: string;
    outcome: MutantOutcome;
    /** The tests that failed under the mutant, named only when that set is the evidence: `overkill` and `survived`. */
    failed?: string[];
}
interface MutantsResult {
    verdict: MutantVerdict;
    results: MutantResult[];
    /**
     * Changed test files no spec in the diff sits beside, less carried tests that load only carried files. A killed spec proves only its own test file, so each of these is
     * unproved. Absent on a line from a judge that predates the check, which therefore proves nothing.
     */
    uncovered?: string[];
    error?: string;
}
/** One spec as the judge read it at head, with the test file its `kills` name tests in. */
interface SpecUnderTest {
    path: string;
    testFile: string;
    mutations: Mutation[];
}
declare const SPEC_SUFFIX = ".mutations.json";
/**
 * The test file a spec sits beside: `<stem>.mutations.json` belongs to the one test at `<stem>.<ext>`, with no dot in ext.
 * Null when no test or more than one matches, since the kills could then name tests in either.
 */
declare function testFileOfSpec(spec: string, files: readonly string[], isTest: (path: string) => boolean): string | null;
/**
 * Classifies every declared mutation against the mutants side's decoded report, whose test file paths are repo-relative.
 * Runs the specs do not declare are ignored, so a report cannot add evidence the specs did not ask for.
 */
declare function classifyMutants(specs: readonly SpecUnderTest[], decoded: DecodedMutants): MutantsResult;

declare const TEST_CLASSES: readonly ["reproduces", "passes-on-base", "new-api", "fails-on-head", "not-run"];
type TestClass = (typeof TEST_CLASSES)[number];
/** `refused` is never classified: fix-proof-run.sh prints it for a base that is not the default branch, and it ran nothing. */
declare const VERDICTS: readonly ["reproduced", "unproven", "vacuous", "no-tests", "error", "refused"];
type Verdict = (typeof VERDICTS)[number];
type FileState = "ran" | "load-error" | "hook-error" | "not-collected";
interface ReportRun {
    /** Absolute directory the report's file paths are relative to. */
    root: string;
    /** Parsed JSON from vitest's `--reporter=json --outputFile`. */
    report: unknown;
}
interface ClassifyInput {
    /** The plan's test paths, the only files whose results count. */
    selected: readonly string[];
    base: ReportRun;
    head: ReportRun;
}
interface TestOutcome {
    file: string;
    name: string;
    class: TestClass;
}
interface FileOutcome {
    file: string;
    base: FileState;
    head: FileState;
}
interface Classification {
    verdict: Verdict;
    tests: TestOutcome[];
    files: FileOutcome[];
    error?: string;
}
/** A failure that says the code under test is missing or reshaped, not that it computed the wrong answer. */
declare function isNewApiFailure(message: string): boolean;
/** Compares base and head vitest reports for the selected test files; anything missing or malformed classifies away from `reproduced`. */
declare function classifyReports(input: ClassifyInput): Classification;

declare const RESULT_PREFIX = "fix-proof/v1 ";
declare const RESULT_LINE_MAX_BYTES = 4096;
interface FixProofResult {
    head: string;
    mergeBase: string;
    verdict: Verdict;
    counts: Record<TestClass, number>;
    notCollected: string[];
    deletedTests: string[];
    configEdited: boolean;
    tests: TestOutcome[];
    /** True when format dropped entries to fit the 4 KB line. */
    truncated: boolean;
    error?: string;
    /**
     * The mutation check, present for a diff of test material alone that adds or changes a mutation spec, and as an error
     * beside an `error` verdict for a source diff whose spec has a kill naming no test at head.
     */
    mutants?: MutantsResult;
    /** The base branch the line judged, as fix-proof-run.sh shows a ref; a judge that predates it prints none. */
    base?: string;
    /** Only on a `refused` line: the default branch fix-proof runs against, which `base` is not. */
    defaultBranch?: string;
}
type ParsedResultLine = {
    ok: true;
    result: FixProofResult;
} | {
    ok: false;
    error: string;
};
/**
 * Whether the mutation check proves a result its base-against-head run cannot. A test-only diff runs the same production
 * code on both sides, so it reads vacuous at best. It is proved when every changed test file has a spec of its own in the
 * diff, every declared mutation is killed, every selected test ran and passed at head, and no test was deleted or renamed
 * out of the tests. A line with no `uncovered` list comes from a judge that never checked coverage, so it proves nothing.
 */
declare function provedByMutants(result: FixProofResult): boolean;
/** Joins a plan and its classification into the result a runner prints for head. */
declare function toResult(args: {
    head: string;
    mergeBase: string;
    plan: FixProofPlan;
    classification: Classification;
}): FixProofResult;
/** Encodes one `fix-proof/v1 <json>` line of at most 4 KB, dropping list entries to fit; throws when the result would not parse back. */
declare function formatResultLine(result: FixProofResult): string;
/** Decodes a result line, refusing anything over 4 KB, of another version, with unknown fields or with duplicate or reordered keys. */
declare function parseResultLine(line: string): ParsedResultLine;

/** Why a read proves nothing about its head; a head can force each of these, so none may pass on its own. */
type FixProofUnverified = "error" | "refused" | "untrusted" | "unread" | "no-repro-test-only" | "no-repro-non-source";
/**
 * A fix-proof read as its readers hold it: a judged `line` (trusted, or `untrusted`), CI's own proof of a workflow-only diff,
 * a read that failed, or one that never ran. `nonSourceProceed` and `testOnlyProceed` mark a NO_REPRO the caller lets through.
 */
type ProofReadInput = ({
    kind: "result";
    line: string;
    testOnlyProceed?: true;
} | {
    kind: "untrusted";
    line: string;
    reason: string;
} | {
    kind: "workflow-ci";
    proved: boolean;
    head: string;
} | {
    kind: "error";
    reason: string;
} | {
    kind: "skipped" | "missing";
    reason?: string;
}) & {
    nonSourceProceed?: true;
};
type WorkflowCiProofRead = Extract<ProofReadInput, {
    kind: "workflow-ci";
}>;
/** The one reading of a fix-proof read at a head. `unproven` is its own standing: it neither ends the review nor proves the head. */
type ProofStanding = {
    kind: "proved";
} | {
    kind: "no-repro";
    proceeds?: "test-only" | "non-source";
    result: FixProofResult | WorkflowCiProofRead;
} | {
    kind: "unverified";
    why: FixProofUnverified;
    detail?: string;
} | {
    kind: "unproven";
} | {
    kind: "none";
};
/**
 * Where a fix-proof read leaves `head`. Every reader derives its answer from this, so a line cannot read as proved to one gate
 * and as NO_REPRO to another. A skipped or missing read expected no proof, so it is `none`.
 */
declare function proofStanding(read: ProofReadInput, head: string): ProofStanding;
/** A NO_REPRO nothing lets through: the review ends before any reviewer starts unless the owner waived the proof. */
declare const endsReview: (standing: ProofStanding) => boolean;
/** Anything short of a proof at the head makes the tests seat blocking; `unproven` does, though it does not end the review. */
declare const needsTestsSeat: (standing: ProofStanding) => boolean;

interface ExecOptions {
    cwd: string;
    timeoutMs: number;
}
interface ExecResult {
    /** Exit code, or null when a signal or the timeout ended the process. */
    status: number | null;
    stdout: string;
    stderr: string;
}
/** Runs one program without a shell; a runner swaps it in tests to observe or fail commands. */
type Exec = (file: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;
/** The default Exec: node's spawn in its own process group, all of it killed at the timeout, never rejecting on a non-zero exit. */
declare const spawnExec: Exec;

interface Shas {
    base: string;
    head: string;
}
/** A verdict error line for the given commits, standing in a zero sha for any that is not a full sha. */
declare function errorLine(refs: Shas, error: string): string;

declare const DEFAULT_BUILD = "pnpm build";
/** The vitest invocation; the runner appends the JSON reporter flags and the selected test paths. */
declare const DEFAULT_COMMAND = "pnpm exec vitest run";

/** Leaves headroom under the CI job's 20-minute timeout so the runner, not the job, reports the overrun. */
declare const DEFAULT_BUDGET_MS: number;

type Side = "base" | "head";
/** The reports each side writes, as `<name>.report` in its out dir; the base runs twice so a flaky reproducer can be ruled out. */
declare const SIDE_REPORTS: Readonly<Record<Side, readonly string[]>>;
/** The report names a side writes: the base's pair, or `head`, `head-2`, ... for each of the head's runs. */
declare function reportNames(side: Side, headRuns?: number): readonly string[];
interface ExecSideOptions {
    /** The git checkout holding both commits. */
    repo: string;
    /** The merge base of the pull request, as a sha or ref. */
    base: string;
    /** The pull request head, as a sha or ref. */
    head: string;
    side: Side;
    /** Directory the encoded reports are written to. */
    out: string;
    budgetMs?: number;
    exec?: Exec;
    /**
     * Runs each base-side vitest call as this user in a fresh PID namespace through `sudo -n`, so nothing the head's test
     * or carried files start outlives the run or can write the runner's files. The head side ignores it.
     */
    sandboxUser?: string;
    /** How many times the head side runs vitest after one install and build, an integer from 1 to 5; default 1. The base side ignores it. */
    headRuns?: number;
}
/** Builds and tests one side of the proof and writes its encoded reports to out; a failure writes error markers, never throws. */
declare function execSide(options: ExecSideOptions): Promise<void>;

interface RunOptions {
    /** The git checkout holding both commits. */
    repo: string;
    /** The merge base of the pull request, as a sha or ref. */
    base: string;
    /** The pull request head, as a sha or ref. */
    head: string;
    budgetMs?: number;
    exec?: Exec;
}
/**
 * Runs both exec sides and the judge in this process and returns one fix-proof/v1 line; the local mode of the three CI jobs.
 * Each side and the judge read their own bare snapshot of the two commits, so nothing either side writes reaches the
 * caller's repo or the judge's. Failures become a verdict error line, never a throw.
 */
declare function run(options: RunOptions): Promise<string>;

declare const USAGE = "usage: fix-proof run|exec|judge --base <mergeBase> --head <sha> [--repo <dir>] [--budget-ms <n>]";
type Runner = typeof run;
/**
 * Parses `fix-proof run|exec|judge` arguments and returns the line to print: one result line for run and judge, and
 * nothing for a successful exec, which writes its reports instead. Bad arguments and failures give a verdict error line.
 */
declare function runCli(argv: readonly string[], cwd: string, runner?: Runner): Promise<string>;

/** Leaves headroom under the mutants job's 15-minute timeout; an overrun is an error marker, never a kill. */
declare const DEFAULT_MUTANTS_BUDGET_MS: number;
/** The mutants side writes its one combined report as `<out>/mutants.report`. */
declare const MUTANTS_REPORT = "mutants";
type ExecMutantsOptions = Omit<ExecSideOptions, "side">;
/**
 * Runs every declared mutation of a test-only diff against the merge base with the head's tests overlaid and writes one
 * `mutants.report`: a skipped marker with no spec or with source in the diff, an error marker on any failure, never a throw.
 * A spec that does not read, pair or check, source diff or not, also writes its reason to `mutants.refused`, which fails
 * the mutants job. With a sandbox user, every build and vitest call after the overlay runs inside the sandbox.
 */
declare function execMutants(options: ExecMutantsOptions): Promise<void>;

/**
 * - `survived`: built and loaded, and no baseline-passing test failed; the only outcome that can make a function pseudo-tested.
 * - `caught`: at least one baseline-passing test failed on an AssertionError.
 * - `caught-error`: baseline-passing tests failed and none on an AssertionError; noticed, but never kill credit.
 * - `load-error`: a suite file with a baseline-passing test failed to load or ran no test, or a failure reads as a new API.
 * - `timeout`: some baseline-passing test failed on vitest's test timeout; never a kill and never a survival.
 */
declare const HEAD_OUTCOMES: readonly ["survived", "caught", "caught-error", "load-error", "timeout"];
type HeadOutcome = (typeof HEAD_OUTCOMES)[number];
interface HeadTest {
    test: string;
    file: string;
}
interface HeadFailure extends HeadTest {
    assertion: boolean;
}
/** One mutant's vitest report reduced to what classifies it, before any cap on the failures listed. */
interface ReducedHeadRun {
    loadError: boolean;
    timeout: boolean;
    failed: HeadFailure[];
}
/** Classifies one built mutant's reduced run; anything that broke or hung is excluded rather than read as survival. */
declare function classifyHeadRun(run: ReducedHeadRun): HeadOutcome;

/** Keeps a caught mutant's evidence small; the outcome is read from every failure before the list is cut. */
declare const MAX_HEAD_FAILURES = 50;
interface ExecHeadMutantsOptions {
    repo: string;
    /** A sha or ref; the worktree is detached at it. */
    head: string;
    mutations: readonly HeadMutation[];
    budgetMs?: number;
    sandboxUser?: string;
    exec?: Exec;
}
interface HeadMutantRun {
    name: string;
    file: string;
    /** The owning package; null means the whole-repo build and test globs. */
    package: string | null;
    built: boolean;
    /** Absent when the mutant did not build or did not apply. */
    outcome?: HeadOutcome;
    /** Baseline-passing tests that failed, at most MAX_HEAD_FAILURES. */
    failed?: HeadFailure[];
    /** Why the mutation never applied: a refused target, a find not exactly once at head, or a package with no tests. */
    error?: string;
}
interface HeadMutantsReport {
    /** The resolved sha, or the ref as given when it did not resolve. */
    head: string;
    /** Test files run, by package; "." stands for a null package. */
    suites: Record<string, string[]>;
    baseline: Array<{
        test: string;
        file: string;
        status: TestStatus;
    }>;
    runs: HeadMutantRun[];
    /** Mutation names never run because the budget ran out or the run failed first; never classified. */
    unrun: string[];
    wallMs: number;
    builds: number;
    error?: string;
}
/**
 * Runs generated mutations against head in a throwaway detached worktree, each against its owning package's tests, and
 * reports each outcome. The caller's checkout is never written. Never throws: a failure is `error`, and every mutation
 * not run by then, the budget's overrun included, is listed in `unrun` and never classified.
 */
declare function execHeadMutants(options: ExecHeadMutantsOptions): Promise<HeadMutantsReport>;

/** Git calls only, so a short budget; the judge's CI job allows 8 minutes. */
declare const DEFAULT_JUDGE_BUDGET_MS: number;
interface JudgeReports {
    /** Encoded reports from the exec jobs, as `encodeReport` or `encodeError` wrote them; absent means the job wrote none. */
    base?: string;
    baseRerun?: string;
    head?: string;
    /** The mutants side's combined report, as `encodeMutantsReport`, `encodeMutantsSkipped` or `encodeError` wrote it. */
    mutants?: string;
}
interface JudgeOptions {
    /** The git checkout holding both commits; the judge reads it with git and never builds or runs it. */
    repo: string;
    base: string;
    head: string;
    reports: JudgeReports;
    /** The PR's base branch, as fix-proof-run.sh shows a ref; the line names it so a reader binds it to the base it judged. */
    baseRef?: string;
    budgetMs?: number;
    exec?: Exec;
}
declare function classifyDecoded(plan: FixProofPlan, reports: JudgeReports): Classification;
/**
 * Classifies the exec sides' encoded reports against a plan it derives from git itself and returns the one fix-proof/v1 line.
 * It runs no code from either commit: every command it spawns is git, so a PR head cannot reach the verdict it prints.
 */
declare function judge(options: JudgeOptions): Promise<string>;

export { CHANGESET_GLOB, CONFIG_PATH, type Classification, type ClassifyInput, type ConfigResult, DEFAULT_BUDGET_MS, DEFAULT_BUILD, DEFAULT_CARRY_GLOBS, DEFAULT_COMMAND, DEFAULT_JUDGE_BUDGET_MS, DEFAULT_MUTANTS_BUDGET_MS, DEFAULT_TEST_GLOBS, type DecodeOptions, type DecodedMutants, type DecodedReport, type Exec, type ExecHeadMutantsOptions, type ExecMutantsOptions, type ExecOptions, type ExecResult, type ExecSideOptions, FIX_PROOF_HARNESS, type FileOutcome, type FileState, type FixProofConfig, type FixProofPlan, type FixProofResult, type FixProofUnverified, HEAD_OUTCOMES, type HeadFailure, type HeadMutantRun, type HeadMutantsReport, type HeadMutation, type HeadOutcome, type JudgeOptions, type JudgeReports, MAX_ENCODED_BYTES, MAX_HEAD_FAILURES, MAX_INFLATED_BYTES, MAX_KILLS, MAX_MUTATIONS, MAX_MUTATION_EDIT, MAX_MUTATION_NAME, MAX_SPEC_BYTES, MUTANTS_REPORT, MUTANT_OUTCOMES, MUTANT_VERDICTS, MUTATION_SPEC_GLOB, type MutantOutcome, type MutantResult, type MutantRun, type MutantVerdict, type MutantsReport, type MutantsResult, type Mutation, type MutationCheck, type MutationSpec, type MutationSpecResult, type ParsedResultLine, type PlanInput, type PlanResult, type ProofReadInput, type ProofStanding, RESULT_LINE_MAX_BYTES, RESULT_PREFIX, type ReducedHeadRun, type ReportRun, type RunOptions, SIDE_REPORTS, SPEC_SUFFIX, type Side, type SpecUnderTest, TEST_CLASSES, type TestClass, type TestOnlyReading, type TestOutcome, USAGE, VERDICTS, type Verdict, checkMutation, classifyDecoded, classifyHeadRun, classifyMutants, classifyReports, compileGlobs, decodeMutantsReport, decodeReport, encodeError, encodeMutantsReport, encodeMutantsSkipped, encodeReport, endsReview, errorLine, execHeadMutants, execMutants, execSide, expandBraces, formatResultLine, isHarnessPath, isNewApiFailure, judge, needsTestsSeat, parseFixProofConfig, parseMutationSpec, parseResultLine, planFixProof, proofStanding, provedByMutants, reportNames, run, runCli, spawnExec, testFileOfSpec, testOnlyOf, testOnlyReading, toResult };
