import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAndClassify, parseOrFail } from "./failures.js";
import { parseRuffJsonOutput } from "../formatters/unified.js";
import type { CheckDiagnostic, ToolFailure } from "../orchestrator/types.js";
import type { RunnerOptions, RunnerResult } from "./types.js";
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

interface RuffJsonMessage {
  code: string | null;
  filename: string;
  message: string;
}

// ruff reports a file it could not parse as a diagnostic with a null code.
function unparsedFiles(stdout: string): ToolFailure[] {
  const entries = JSON.parse(stdout) as RuffJsonMessage[];
  return entries
    .filter((e) => e.code === null)
    .map((e) => ({ tool: "ruff" as const, kind: "file-not-checked" as const, file: e.filename, message: e.message }));
}

function readRuffOutput(stdout: string): { diagnostics: CheckDiagnostic[]; failures: ToolFailure[] } {
  const parsed = parseOrFail("ruff", () => ({
    diagnostics: parseRuffJsonOutput(stdout),
    failures: unparsedFiles(stdout),
  }));
  return parsed.ok ? parsed.value : { diagnostics: [], failures: [parsed.failure] };
}

export async function runRuff(
  config: RuffConfig,
  files: string[],
  options?: RunnerOptions,
): Promise<RunnerResult> {
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

    const run = await runAndClassify("ruff", "ruff", args, { cwd: options?.cwd, timeout: options?.timeout });
    if (!run.ok) return { diagnostics: [], exitCode: run.exitCode, failures: [run.failure], skippedRules: [] };
    return { ...readRuffOutput(run.stdout), exitCode: run.exitCode, skippedRules: [] };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
