import type { Profile, Severity } from "@titan-design/style-profile";

export type { Severity };

export interface CheckDiagnostic {
  file: string;
  line: number;
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

export interface OrchestratorOptions {
  profile: Profile;
  files: string[];
  fix?: boolean;
  language?: "typescript" | "python";
}

export interface OrchestratorResult {
  diagnostics: CheckDiagnostic[];
  summary: {
    total: number;
    errors: number;
    warnings: number;
    infos: number;
    fixed: number;
  };
}
