import type { Profile, Severity } from "@titan-design/style-profile";

export type { Severity };

export interface CheckDiagnostic {
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

export interface CheckResult {
  diagnostics: CheckDiagnostic[];
  tool: "eslint" | "ruff";
  exitCode: number;
}

export type ToolName = "eslint" | "ruff" | "vulture" | "pydoclint" | "pyright" | "import-linter" | "suppressions";

export type ToolFailureKind =
  | "spawn-failed"
  | "timeout"
  | "signal"
  | "exit-code"
  | "unparseable-output"
  | "file-not-checked"
  | "missing-dependency";

export interface ToolFailure {
  tool: ToolName;
  kind: ToolFailureKind;
  message: string;
  file?: string;
}

export interface SkippedRule {
  tool: "eslint";
  rule: string;
  plugin: string;
  reason: string;
}

export interface OrchestratorOptions {
  profile: Profile;
  files: string[];
  fix?: boolean;
  language?: "typescript" | "python";
}

export interface OrchestratorResult {
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
