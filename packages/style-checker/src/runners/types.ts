import type {
  CheckDiagnostic,
  SkippedRule,
  ToolFailure,
} from "../orchestrator/types.js";

export interface RunnerResult {
  diagnostics: CheckDiagnostic[];
  exitCode: number | null;
  failures: ToolFailure[];
  skippedRules: SkippedRule[];
  /** Non-fatal notes, such as a tool that is not installed; absent from runners that never warn. */
  warnings?: string[];
}

export interface RunnerOptions {
  fix?: boolean;
  cwd?: string;
  timeout?: number;
}
