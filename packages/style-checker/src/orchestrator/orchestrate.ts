import { generateEslintConfig } from "../generators/eslint.js";
import { generateRuffConfig } from "../generators/ruff.js";
import { runEslint } from "../runners/eslint-runner.js";
import { runRuff } from "../runners/ruff-runner.js";
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

export async function orchestrate(
  options: OrchestratorOptions,
): Promise<OrchestratorResult> {
  const { profile, files, fix } = options;
  const language = options.language ?? detectLanguage(files);
  const allDiagnostics: CheckDiagnostic[] = [];

  const tsFiles = files.filter((f) => /\.[tj]sx?$/.test(f));
  const pyFiles = files.filter((f) => /\.py$/.test(f));

  if (
    (language === "typescript" || language === "mixed") &&
    tsFiles.length > 0
  ) {
    const eslintConfig = generateEslintConfig(profile);
    if (eslintConfig.length > 0) {
      const result = await runEslint(eslintConfig, tsFiles, { fix });
      allDiagnostics.push(...result.diagnostics);
    }
  }

  if ((language === "python" || language === "mixed") && pyFiles.length > 0) {
    const ruffConfig = generateRuffConfig(profile);
    if (ruffConfig.lint?.select && ruffConfig.lint.select.length > 0) {
      const result = await runRuff(ruffConfig, pyFiles, { fix });
      allDiagnostics.push(...result.diagnostics);
    }
  }

  return {
    diagnostics: allDiagnostics,
    summary: buildSummary(allDiagnostics),
  };
}
