import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTool } from "./tool-runner.js";
import { parseRuffJsonOutput } from "../formatters/unified.js";
import type { CheckDiagnostic } from "../orchestrator/types.js";
import type { RuffConfig } from "../generators/ruff.js";

type RuffLint = NonNullable<RuffConfig["lint"]>;

function quoteList(values: string[]): string {
  return `[${values.map((s) => `"${s}"`).join(", ")}]`;
}

function lintSelectionLines(lint: RuffLint): string[] {
  const lines: string[] = [];
  if (lint.select) lines.push(`select = ${quoteList(lint.select)}`);
  if (lint.ignore) lines.push(`ignore = ${quoteList(lint.ignore)}`);
  return lines;
}

function lintSubsectionLines(lint: RuffLint): string[] {
  const lines: string[] = [];
  if (lint.mccabe) {
    lines.push("[lint.mccabe]");
    if (lint.mccabe["max-complexity"]) {
      lines.push(`max-complexity = ${lint.mccabe["max-complexity"]}`);
    }
  }
  if (lint.pydocstyle) {
    lines.push("[lint.pydocstyle]");
    if (lint.pydocstyle.convention) {
      lines.push(`convention = "${lint.pydocstyle.convention}"`);
    }
  }
  if (lint.isort) {
    lines.push("[lint.isort]");
    if (lint.isort["section-order"]) {
      lines.push(`section-order = ${quoteList(lint.isort["section-order"])}`);
    }
  }
  return lines;
}

function toToml(config: RuffConfig): string {
  const lines: string[] = [];

  if (config["line-length"]) {
    lines.push(`line-length = ${config["line-length"]}`);
  }

  if (config.lint) {
    lines.push("[lint]", ...lintSelectionLines(config.lint), ...lintSubsectionLines(config.lint));
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
