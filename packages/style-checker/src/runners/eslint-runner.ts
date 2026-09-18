import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAndClassify, parseOrFail } from "./failures.js";
import { buildEslintConfigModule } from "./eslint-config-module.js";
import { parseEslintJsonOutput } from "../formatters/unified.js";
import type { CheckDiagnostic, ToolFailure } from "../orchestrator/types.js";
import type { EslintFlatConfigEntry } from "../generators/eslint.js";
import type { RunnerOptions, RunnerResult } from "./types.js";

interface EslintJsonMessage {
  ruleId: string | null;
  fatal?: boolean;
  message: string;
}

// ESLint reports a file it could not lint as a rule-less message: a fatal parse error, or "File ignored ...".
function uncheckedFiles(stdout: string): ToolFailure[] {
  const entries = JSON.parse(stdout) as Array<{ filePath: string; messages: EslintJsonMessage[] }>;
  return entries.flatMap((entry) =>
    entry.messages
      .filter((m) => m.ruleId === null && (m.fatal === true || m.message.startsWith("File ignored")))
      .map((m) => ({ tool: "eslint" as const, kind: "file-not-checked" as const, file: entry.filePath, message: m.message })),
  );
}

function readEslintOutput(stdout: string): { diagnostics: CheckDiagnostic[]; failures: ToolFailure[] } {
  const parsed = parseOrFail("eslint", () => ({
    diagnostics: parseEslintJsonOutput(stdout),
    failures: uncheckedFiles(stdout),
  }));
  return parsed.ok ? parsed.value : { diagnostics: [], failures: [parsed.failure] };
}

function eslintArgs(configPath: string, files: string[], fix?: boolean): string[] {
  // --no stops npx from downloading an ESLint the project has not installed.
  return ["--no", "--", "eslint", "--config", configPath, "--format", "json", ...(fix ? ["--fix"] : []), ...files];
}

export async function runEslint(
  config: EslintFlatConfigEntry[],
  files: string[],
  options?: RunnerOptions,
): Promise<RunnerResult> {
  const cwd = options?.cwd ?? process.cwd();
  const built = buildEslintConfigModule(config, cwd);
  if (!built.ok) return { diagnostics: [], exitCode: null, failures: [built.failure], skippedRules: [] };
  const { skippedRules } = built;
  if (built.ruleCount === 0) return { diagnostics: [], exitCode: null, failures: [], skippedRules };

  const tempDir = mkdtempSync(join(tmpdir(), "codewatch-eslint-"));
  const configPath = join(tempDir, "eslint.config.mjs");
  try {
    writeFileSync(configPath, built.source, "utf-8");
    const run = await runAndClassify("eslint", "npx", eslintArgs(configPath, files, options?.fix), {
      cwd,
      timeout: options?.timeout,
    });
    if (!run.ok) return { diagnostics: [], exitCode: run.exitCode, failures: [run.failure], skippedRules };
    return { ...readEslintOutput(run.stdout), exitCode: run.exitCode, skippedRules };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
