import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTool } from "./tool-runner.js";
import { parseEslintJsonOutput } from "../formatters/unified.js";
import type { CheckDiagnostic } from "../orchestrator/types.js";
import type { EslintFlatConfigEntry } from "../generators/eslint.js";

export async function runEslint(
  config: EslintFlatConfigEntry[],
  files: string[],
  options?: { fix?: boolean },
): Promise<{ diagnostics: CheckDiagnostic[]; exitCode: number }> {
  const tempDir = mkdtempSync(join(tmpdir(), "codewatch-eslint-"));
  const configPath = join(tempDir, "eslint.config.js");

  try {
    const configContent = `export default ${JSON.stringify(config, null, 2)};`;
    writeFileSync(configPath, configContent, "utf-8");

    const args = [
      "--config",
      configPath,
      "--format",
      "json",
      ...(options?.fix ? ["--fix"] : []),
      ...files,
    ];

    const result = await runTool("npx", ["eslint", ...args]);
    const diagnostics =
      result.stdout.trim() ? parseEslintJsonOutput(result.stdout) : [];

    return { diagnostics, exitCode: result.exitCode };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
