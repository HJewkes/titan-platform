import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAndClassify, parseOrFail } from "./failures.js";
import { isRuffSyntaxError, parseRuffJsonOutput } from "../formatters/unified.js";
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
  if (config.preview) lines.push("preview = true");

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

function notChecked(file: string, message: string): ToolFailure {
  return { tool: "ruff", kind: "file-not-checked", file, message };
}

// ruff emits one entry per syntax error; a file that fails to parse is reported once.
function unparsedFiles(stdout: string): ToolFailure[] {
  const byFile = new Map<string, string[]>();
  for (const e of JSON.parse(stdout) as RuffJsonMessage[]) {
    if (!isRuffSyntaxError(e.code)) continue;
    byFile.set(e.filename, [...(byFile.get(e.filename) ?? []), e.message]);
  }
  return [...byFile].map(([file, messages]) => notChecked(file, messages.join("; ")));
}

// ruff 0.16.8 flags an unreadable path (exit 0, "[]") only in this stderr wording; if ruff rewords it, the case goes silent again.
function unreadFiles(stderr: string): ToolFailure[] {
  return [...stderr.matchAll(/^warning: Failed to lint (.+?): (.+)$/gm)].map((m) => notChecked(m[1]!, m[2]!));
}

function readRuffOutput(stdout: string, stderr: string): { diagnostics: CheckDiagnostic[]; failures: ToolFailure[] } {
  const parsed = parseOrFail("ruff", () => ({
    diagnostics: parseRuffJsonOutput(stdout),
    failures: [...unparsedFiles(stdout), ...unreadFiles(stderr)],
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
    return { ...readRuffOutput(run.stdout, run.stderr), exitCode: run.exitCode, skippedRules: [] };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
