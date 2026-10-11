/** Where a target repo keeps its fix-proof config; read at the merge base, never at head. */
declare const CONFIG_PATH = ".github/fix-proof.json";
declare const DEFAULT_TEST_GLOBS: readonly string[];
declare const DEFAULT_CARRY_GLOBS: readonly string[];
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
/** Splits a merge-base-to-head diff into tests to run, carried support files and deleted tests, using globs from the base config only. */
declare function planFixProof(input: PlanInput): PlanResult;

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

/** Leaves headroom under the CI job's 20-minute timeout so the runner, not the job, reports the overrun. */
declare const DEFAULT_BUDGET_MS: number;
declare const DEFAULT_BUILD = "pnpm build";
/** The vitest invocation; the runner appends the JSON reporter flags and the selected test paths. */
declare const DEFAULT_COMMAND = "pnpm exec vitest run";
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
/** A verdict error line for the given commits, standing in a zero sha for any that is not a full sha. */
declare function errorLine(refs: {
    base: string;
    head: string;
}, error: string): string;
/** Runs the head's tests over the merge base and at head and returns one fix-proof/v1 line; failures become a verdict error line, never a throw. */
declare function run(options: RunOptions): Promise<string>;

declare const USAGE = "usage: fix-proof run --base <mergeBase> --head <sha> [--repo <dir>] [--budget-ms <n>]";
/** Parses `fix-proof run` arguments and returns the one result line to print; bad arguments give a verdict error line too. */
declare function runCli(argv: readonly string[], cwd: string, runner?: typeof run): Promise<string>;

export { CONFIG_PATH, type Classification, type ClassifyInput, type ConfigResult, DEFAULT_BUDGET_MS, DEFAULT_BUILD, DEFAULT_CARRY_GLOBS, DEFAULT_COMMAND, DEFAULT_TEST_GLOBS, type Exec, type ExecOptions, type ExecResult, type FileOutcome, type FileState, type FixProofConfig, type FixProofPlan, type FixProofResult, type ParsedResultLine, type PlanInput, type PlanResult, RESULT_LINE_MAX_BYTES, RESULT_PREFIX, type ReportRun, type RunOptions, TEST_CLASSES, type TestClass, type TestOutcome, USAGE, VERDICTS, type Verdict, classifyReports, compileGlobs, errorLine, expandBraces, formatResultLine, parseFixProofConfig, parseResultLine, planFixProof, run, runCli, spawnExec, toResult };
