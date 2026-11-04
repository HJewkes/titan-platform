import { readFileSync } from "node:fs";
import path from "node:path";
import { appDirs } from "@titan-design/app-paths";
import type { Command } from "commander";
import { z } from "zod";
import { BASELINE_USD, foldCost, formatCostReport, type UsageEntry } from "./cost.js";

const UsageEntrySchema = z.object({
  stage: z.string(),
  model: z.string(),
  inputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWrite5mTokens: z.number().optional(),
  cacheWrite1hTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cliCostUsd: z.number().optional(),
});

/** Run layout S4 must write: `<runsDir>/<runId>/cost.json`, a JSON array of one entry per model call. */
export function costFilePath(runsDir: string, runId: string): string {
  return path.join(runsDir, runId, "cost.json");
}

export function readUsageEntries(file: string): UsageEntry[] {
  return z.array(UsageEntrySchema).parse(JSON.parse(readFileSync(file, "utf8")));
}

export function costReportText(runsDir: string, runId: string, baselineUsd: number = BASELINE_USD): string {
  const entries = readUsageEntries(costFilePath(runsDir, runId));
  return formatCostReport(foldCost(entries, { asOf: new Date().toISOString(), baselineUsd }));
}

export function registerCostCommand(program: Command, write: (line: string) => void): void {
  program
    .command("cost <runId>")
    .description("Print a run's token and USD cost by stage and model, against the baseline")
    .option("--baseline-usd <usd>", "baseline cost to compare against", String(BASELINE_USD))
    .option("--runs-dir <dir>", "runs directory (default: per-user data dir)")
    .action((runId: string, opts: { baselineUsd: string; runsDir?: string }) => {
      const runsDir = opts.runsDir ?? path.join(appDirs("corpus-query").data, "runs");
      write(costReportText(runsDir, runId, Number(opts.baselineUsd)));
    });
}
