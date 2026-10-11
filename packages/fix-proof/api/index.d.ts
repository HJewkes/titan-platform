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

export { CONFIG_PATH, type Classification, type ClassifyInput, type ConfigResult, DEFAULT_CARRY_GLOBS, DEFAULT_TEST_GLOBS, type FileOutcome, type FileState, type FixProofConfig, type FixProofPlan, type FixProofResult, type ParsedResultLine, type PlanInput, type PlanResult, RESULT_LINE_MAX_BYTES, RESULT_PREFIX, type ReportRun, TEST_CLASSES, type TestClass, type TestOutcome, VERDICTS, type Verdict, classifyReports, compileGlobs, expandBraces, formatResultLine, parseFixProofConfig, parseResultLine, planFixProof, toResult };
