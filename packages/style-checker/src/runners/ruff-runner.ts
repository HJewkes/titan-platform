import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTool } from "./tool-runner.js";
import { parseRuffJsonOutput } from "../formatters/unified.js";
import type { CheckDiagnostic } from "../orchestrator/types.js";
import type { RuffConfig } from "../generators/ruff.js";

function toToml(config: RuffConfig): string {
  const lines: string[] = [];

  if (config["line-length"]) {
    lines.push(`line-length = ${config["line-length"]}`);
  }

  if (config.lint) {
    lines.push("[lint]");
    if (config.lint.select) {
      lines.push(
        `select = [${config.lint.select.map((s) => `"${s}"`).join(", ")}]`,
      );
    }
    if (config.lint.ignore) {
      lines.push(
        `ignore = [${config.lint.ignore.map((s) => `"${s}"`).join(", ")}]`,
      );
    }
    if (config.lint.mccabe) {
      lines.push("[lint.mccabe]");
      if (config.lint.mccabe["max-complexity"]) {
        lines.push(
          `max-complexity = ${config.lint.mccabe["max-complexity"]}`,
        );
      }
    }
    if (config.lint.pydocstyle) {
      lines.push("[lint.pydocstyle]");
      if (config.lint.pydocstyle.convention) {
        lines.push(`convention = "${config.lint.pydocstyle.convention}"`);
      }
    }
    if (config.lint.isort) {
      lines.push("[lint.isort]");
      if (config.lint.isort["section-order"]) {
        lines.push(
          `section-order = [${config.lint.isort["section-order"].map((s) => `"${s}"`).join(", ")}]`,
        );
      }
    }
  }

  return lines.join("\n") + "\n";
}

export async function runRuff(
  config: RuffConfig,
  files: string[],
  options?: { fix?: boolean },
): Promise<{ diagnostics: CheckDiagnostic[]; exitCode: number }> {
  const tempDir = mkdtempSync(join(tmpdir(), "codewatch-ruff-"));
  const configPath = join(tempDir, "ruff.toml");

  try {
    writeFileSync(configPath, toToml(config), "utf-8");

    const args = [
      "check",
      "--config",
      configPath,
      "--output-format",
      "json",
      ...(options?.fix ? ["--fix"] : []),
      ...files,
    ];

    const result = await runTool("ruff", args);
    const diagnostics =
      result.stdout.trim() ? parseRuffJsonOutput(result.stdout) : [];

    return { diagnostics, exitCode: result.exitCode };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
