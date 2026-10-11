import { Severity, Profile } from '@titan-design/style-profile';
export { Severity } from '@titan-design/style-profile';
import { Observation } from '@titan-design/style-analyzer';

interface CheckDiagnostic {
    file: string;
    line: number;
    /** Last line of the flagged range, when the tool reports one. */
    endLine?: number;
    column: number;
    severity: Exclude<Severity, "off">;
    message: string;
    category: string;
    rule: string;
    fixable: boolean;
    fix?: {
        range: [number, number];
        text: string;
    };
}
interface CheckResult {
    diagnostics: CheckDiagnostic[];
    tool: "eslint" | "ruff";
    exitCode: number;
}
type ToolName = "eslint" | "ruff" | "vulture" | "pydoclint" | "pyright" | "import-linter" | "suppressions";
type ToolFailureKind = "spawn-failed" | "timeout" | "signal" | "exit-code" | "unparseable-output" | "file-not-checked" | "missing-dependency";
interface ToolFailure {
    tool: ToolName;
    kind: ToolFailureKind;
    message: string;
    file?: string;
}
interface SkippedRule {
    tool: "eslint";
    rule: string;
    plugin: string;
    reason: string;
}
interface OrchestratorOptions {
    profile: Profile;
    files: string[];
    fix?: boolean;
    language?: "typescript" | "python";
}
interface OrchestratorResult {
    diagnostics: CheckDiagnostic[];
    /** Empty only when every tool that ran checked every file it was given. */
    failures: ToolFailure[];
    skippedRules: SkippedRule[];
    summary: {
        total: number;
        errors: number;
        warnings: number;
        infos: number;
        fixed: number;
    };
}

declare function orchestrate(options: OrchestratorOptions): Promise<OrchestratorResult>;

interface EslintFlatConfigEntry {
    plugins?: Record<string, unknown>;
    rules?: Record<string, unknown>;
    files?: string[];
}
interface EslintConfigResult {
    entries: EslintFlatConfigEntry[];
    skippedRules: SkippedRule[];
}
declare function generateEslintConfig(profile: Profile): EslintConfigResult;

interface RuffConfig {
    lint?: {
        select?: string[];
        ignore?: string[];
        fixable?: string[];
        "per-file-ignores"?: Record<string, string[]>;
        mccabe?: {
            "max-complexity"?: number;
        };
        pydocstyle?: {
            convention?: string;
        };
        isort?: {
            "known-first-party"?: string[];
            "section-order"?: string[];
        };
    };
    "line-length"?: number;
    preview?: boolean;
}
declare function generateRuffConfig(profile: Profile): RuffConfig;

/** The audit's pinned ruff selection: complexity, size, dead code, and defensive-bloat signals. */
declare const AUDIT_RUFF_RULES: readonly string[];
/** Preview is on because ruff 0.16.8 silently skips PLR0904, PLR0914, PLR0916 and PLR1702 without it. */
declare function generateRuffAuditConfig(): RuffConfig;

interface RunnerResult {
    diagnostics: CheckDiagnostic[];
    exitCode: number | null;
    failures: ToolFailure[];
    skippedRules: SkippedRule[];
    /** Non-fatal notes, such as a tool that is not installed; absent from runners that never warn. */
    warnings?: string[];
}
interface RunnerOptions {
    fix?: boolean;
    cwd?: string;
    timeout?: number;
}

type AuditOptions = Omit<RunnerOptions, "fix">;

/** Runs the pinned audit rule set; diagnostics and failures carry paths relative to `cwd`, since ruff reports absolute ones. */
declare function runRuffAudit(files: string[], options?: AuditOptions): Promise<RunnerResult>;

/** The audit's pinned pyright selection: checks whose finding is a guard or conversion the types already make redundant. */
declare const AUDIT_PYRIGHT_RULES: readonly string[];
type PyrightConfig = Record<string, string | string[]>;
/** Everything off except the audit rules, as warnings; `root` goes on extraPaths so the project's own imports resolve. */
declare function generatePyrightAuditConfig(root: string): PyrightConfig;

interface VultureOptions extends AuditOptions {
    /** vulture's --min-confidence; 60 keeps its uncertain unused-code guesses, 100 keeps only unreachable code. */
    minConfidence?: number;
}
/** Dead-code candidates from vulture at `minConfidence` (default 60); rule ids are vulture/<kind>. */
declare function runVultureAudit(files: string[], options?: VultureOptions): Promise<RunnerResult>;

type DocstringStyle = "numpy" | "google" | "sphinx";
interface PydoclintOptions extends AuditOptions {
    style?: DocstringStyle;
}
/** Docstring-versus-signature drift from pydoclint in `style` (default numpy); rule ids are pydoclint/DOCnnn. */
declare function runPydoclintAudit(files: string[], options?: PydoclintOptions): Promise<RunnerResult>;

interface PyrightOptions extends AuditOptions {
    /** The interpreter whose site-packages pyright resolves third-party imports from. */
    pythonPath?: string;
}
/** Redundant isinstance, comparison, contains and cast findings from pyright; rule ids are pyright/<rule>. */
declare function runPyrightAudit(files: string[], options?: PyrightOptions): Promise<RunnerResult>;

declare const NO_IMPORT_LINTER_CONFIG = "no import-linter config";
/** One diagnostic per broken import chain; runs only when the project configures import-linter. */
declare function runImportLinter(options?: AuditOptions): Promise<RunnerResult>;

declare const NOQA_RULE = "suppression/noqa";
declare const TYPE_IGNORE_RULE = "suppression/type-ignore";
/** Every `# noqa` and `# type: ignore` marker in one file's text, one diagnostic per occurrence. */
declare function findSuppressions(file: string, text: string): CheckDiagnostic[];
/** Suppression markers across `files`, read from disk relative to `cwd`; no tool is run. */
declare function countSuppressions(files: string[], options?: {
    cwd?: string;
}): RunnerResult;
interface SuppressionCounts {
    noqa: number;
    typeIgnore: number;
}
interface SuppressionTotals extends SuppressionCounts {
    byFile: Record<string, SuppressionCounts>;
}
/** Totals of countSuppressions' diagnostics, overall and per file; other diagnostics are ignored. */
declare function suppressionTotals(diagnostics: CheckDiagnostic[]): SuppressionTotals;

declare function parseEslintJsonOutput(jsonStr: string): CheckDiagnostic[];
declare function parseRuffJsonOutput(jsonStr: string): CheckDiagnostic[];
declare function formatDiagnostic(d: CheckDiagnostic): string;

interface Deviation {
    file: string;
    line: number;
    rule: string;
    expected: string;
    found: string;
    severity: "error" | "warn" | "info";
}
interface DiffResult {
    deviations: Deviation[];
    summary: {
        total: number;
        matching: number;
        deviating: number;
    };
}
declare function diffAgainstProfile(profile: Profile, observations: Observation[]): DiffResult;

export { AUDIT_PYRIGHT_RULES, AUDIT_RUFF_RULES, type AuditOptions, type CheckDiagnostic, type CheckResult, type Deviation, type DiffResult, type DocstringStyle, type EslintConfigResult, type EslintFlatConfigEntry, NOQA_RULE, NO_IMPORT_LINTER_CONFIG, type OrchestratorOptions, type OrchestratorResult, type PydoclintOptions, type PyrightConfig, type PyrightOptions, type RuffConfig, type RunnerOptions, type RunnerResult, type SkippedRule, type SuppressionCounts, type SuppressionTotals, TYPE_IGNORE_RULE, type ToolFailure, type ToolFailureKind, type ToolName, type VultureOptions, countSuppressions, diffAgainstProfile, findSuppressions, formatDiagnostic, generateEslintConfig, generatePyrightAuditConfig, generateRuffAuditConfig, generateRuffConfig, orchestrate, parseEslintJsonOutput, parseRuffJsonOutput, runImportLinter, runPydoclintAudit, runPyrightAudit, runRuffAudit, runVultureAudit, suppressionTotals };
