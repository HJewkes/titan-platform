/** Where a target repo keeps its fix-proof config; read at the merge base, never at head. */
declare const CONFIG_PATH = ".github/fix-proof.json";
declare const DEFAULT_TEST_GLOBS: readonly string[];
declare const DEFAULT_CARRY_GLOBS: readonly string[];
/**
 * Mutation specs sit next to their test as `<test file minus extension>.mutations.json`. A fixed glob, not a config key:
 * the config parser refuses unknown keys, so a key would fail every run whose merge base predates it.
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
/** A matcher for repo-relative POSIX paths supporting `**`, `*`, `?` and `{a,b}`. */
declare function compileGlobs(globs: readonly string[]): (path: string) => boolean;

interface PlanInput {
    /** Output of `git diff -M --name-status <mergeBase> <head>`. */
    nameStatus: string;
    /** `.github/fix-proof.json` at the merge base; null or absent when the file does not exist there. */
    baseConfig?: string | null;
    /** The same file at head, used only to tell the reviewer the PR edited it. */
    headConfig?: string | null;
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
/** True when the diff touches only tests, carried files, mutation specs and changesets, none of them harness paths. */
declare function testOnlyOf(plan: Pick<FixProofPlan, "source">): boolean;
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
 * harness path, and must exist there (`baseText` null means it does not) with `find` occurring exactly once.
 */
declare function checkMutation(mutation: Mutation, baseText: string | null, config: FixProofConfig): MutationCheck;

declare const TEST_CLASSES: readonly ["reproduces", "passes-on-base", "new-api", "fails-on-head", "not-run"];
type TestClass = (typeof TEST_CLASSES)[number];
declare const VERDICTS: readonly ["reproduced", "unproven", "vacuous", "no-tests", "error"];
type Verdict = (typeof VERDICTS)[number];
type FileState = "ran" | "load-error" | "not-collected";
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
}
type ParsedResultLine = {
    ok: true;
    result: FixProofResult;
} | {
    ok: false;
    error: string;
};
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

/** Leaves headroom under the CI job's 20-minute timeout so the runner, not the job, reports the overrun. */
declare const DEFAULT_BUDGET_MS: number;
declare const DEFAULT_BUILD = "pnpm build";
/** The vitest invocation; the runner appends the JSON reporter flags and the selected test paths. */
declare const DEFAULT_COMMAND = "pnpm exec vitest run";
type Side = "base" | "head";
/** The reports each side writes, as `<name>.report` in its out dir; the base runs twice so a flaky reproducer can be ruled out. */
declare const SIDE_REPORTS: Readonly<Record<Side, readonly string[]>>;
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

/** Git calls only, so a short budget; the judge's CI job allows 8 minutes. */
declare const DEFAULT_JUDGE_BUDGET_MS: number;
interface JudgeReports {
    /** Encoded reports from the exec jobs, as `encodeReport` or `encodeError` wrote them; absent means the job wrote none. */
    base?: string;
    baseRerun?: string;
    head?: string;
}
interface JudgeOptions {
    /** The git checkout holding both commits; the judge reads it with git and never builds or runs it. */
    repo: string;
    base: string;
    head: string;
    reports: JudgeReports;
    budgetMs?: number;
    exec?: Exec;
}
/**
 * Classifies the exec sides' encoded reports against a plan it derives from git itself and returns the one fix-proof/v1 line.
 * It runs no code from either commit: every command it spawns is git, so a PR head cannot reach the verdict it prints.
 */
declare function judge(options: JudgeOptions): Promise<string>;

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

export { CHANGESET_GLOB, CONFIG_PATH, type Classification, type ClassifyInput, type ConfigResult, DEFAULT_BUDGET_MS, DEFAULT_BUILD, DEFAULT_CARRY_GLOBS, DEFAULT_COMMAND, DEFAULT_JUDGE_BUDGET_MS, DEFAULT_TEST_GLOBS, type DecodeOptions, type DecodedReport, type Exec, type ExecOptions, type ExecResult, type ExecSideOptions, FIX_PROOF_HARNESS, type FileOutcome, type FileState, type FixProofConfig, type FixProofPlan, type FixProofResult, type JudgeOptions, type JudgeReports, MAX_ENCODED_BYTES, MAX_INFLATED_BYTES, MAX_KILLS, MAX_MUTATIONS, MAX_MUTATION_EDIT, MAX_MUTATION_NAME, MAX_SPEC_BYTES, MUTATION_SPEC_GLOB, type Mutation, type MutationCheck, type MutationSpec, type MutationSpecResult, type ParsedResultLine, type PlanInput, type PlanResult, RESULT_LINE_MAX_BYTES, RESULT_PREFIX, type ReportRun, type RunOptions, SIDE_REPORTS, type Side, TEST_CLASSES, type TestClass, type TestOutcome, USAGE, VERDICTS, type Verdict, checkMutation, classifyReports, compileGlobs, decodeReport, encodeError, encodeReport, errorLine, execSide, expandBraces, formatResultLine, isHarnessPath, judge, parseFixProofConfig, parseMutationSpec, parseResultLine, planFixProof, run, runCli, spawnExec, testOnlyOf, toResult };
