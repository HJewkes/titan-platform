import { generateEslintConfig } from "../generators/eslint.js";
import { generateRuffConfig } from "../generators/ruff.js";
import { runEslint } from "../runners/eslint-runner.js";
import { runRuff } from "../runners/ruff-runner.js";
import type { RunnerResult } from "../runners/types.js";
import type {
  OrchestratorOptions,
  OrchestratorResult,
  CheckDiagnostic,
} from "./types.js";

function detectLanguage(files: string[]): "typescript" | "python" | "mixed" {
  const tsFiles = files.filter((f) => /\.[tj]sx?$/.test(f));
  const pyFiles = files.filter((f) => /\.py$/.test(f));
  if (tsFiles.length > 0 && pyFiles.length === 0) return "typescript";
  if (pyFiles.length > 0 && tsFiles.length === 0) return "python";
  return "mixed";
}

function buildSummary(
  diagnostics: CheckDiagnostic[],
): OrchestratorResult["summary"] {
  return {
    total: diagnostics.length,
    errors: diagnostics.filter((d) => d.severity === "error").length,
    warnings: diagnostics.filter((d) => d.severity === "warn").length,
    infos: diagnostics.filter((d) => d.severity === "info").length,
    fixed: 0,
  };
}

async function runTools(options: OrchestratorOptions): Promise<RunnerResult[]> {
  const { profile, files, fix } = options;
  const language = options.language ?? detectLanguage(files);
  const tsFiles = files.filter((f) => /\.[tj]sx?$/.test(f));
  const pyFiles = files.filter((f) => /\.py$/.test(f));
  const results: RunnerResult[] = [];

  if ((language === "typescript" || language === "mixed") && tsFiles.length > 0) {
    const eslintConfig = generateEslintConfig(profile);
    if (eslintConfig.length > 0) results.push(await runEslint(eslintConfig, tsFiles, { fix }));
  }

  if ((language === "python" || language === "mixed") && pyFiles.length > 0) {
    const ruffConfig = generateRuffConfig(profile);
    if (ruffConfig.lint?.select && ruffConfig.lint.select.length > 0) {
      results.push(await runRuff(ruffConfig, pyFiles, { fix }));
    }
  }
  return results;
}

export async function orchestrate(
  options: OrchestratorOptions,
): Promise<OrchestratorResult> {
  const results = await runTools(options);
  const diagnostics = results.flatMap((r) => r.diagnostics);
  return {
    diagnostics,
    failures: results.flatMap((r) => r.failures),
    skippedRules: results.flatMap((r) => r.skippedRules),
    summary: buildSummary(diagnostics),
  };
}
