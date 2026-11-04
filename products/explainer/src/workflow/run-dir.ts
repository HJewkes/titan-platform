import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ZodType } from "zod";

export interface RunPaths {
  runDir: string;
  /** Written when the run stops at its spend cap. */
  stop: string;
  /** A failed stage's record: its timing and spend, which the workflow store never sees. */
  failed: (stage: string) => string;
  logs: string;
  reportMd: string;
  reportJson: string;
}

export function runPaths(dataDir: string, runId: string): RunPaths {
  const runDir = path.join(dataDir, "runs", runId);
  return {
    runDir,
    stop: path.join(runDir, "stop.json"),
    failed: (stage) => path.join(runDir, "failed", `${stage}.json`),
    logs: path.join(runDir, "logs"),
    reportMd: path.join(runDir, "run-report.md"),
    reportJson: path.join(runDir, "run-report.json"),
  };
}

/** Atomic, so a crash mid-write never leaves a half file that a resume or report would trust. */
export function writeJson(file: string, value: unknown): void {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeText(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function readJson<T>(file: string, schema: ZodType<T>): T | undefined {
  return existsSync(file) ? schema.parse(JSON.parse(readFileSync(file, "utf8"))) : undefined;
}
