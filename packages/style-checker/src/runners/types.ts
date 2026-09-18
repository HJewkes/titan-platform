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
}

export interface RunnerOptions {
  fix?: boolean;
  cwd?: string;
  timeout?: number;
}
