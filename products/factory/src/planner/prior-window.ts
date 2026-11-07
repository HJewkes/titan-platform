import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PlannerConfig } from "./config.js";
import type { PlannerRun } from "./inputs.js";

type PriorWindow = NonNullable<PlannerConfig["priorWindow"]>;

const PROBES = [
  ["merges", "merges"],
  ["ownerContact", "owner contact"],
  ["newRed", "new red"],
] as const satisfies readonly (readonly [keyof PriorWindow, string])[];

/** The review dir's skip log: `.log`, so the post-spawn watch never reads a skip as the planner's review. */
export const SKIP_LOG = "skipped.log";

type WindowVerdict = { kind: "quiet"; summary: string } | { kind: "active" } | { kind: "unknown"; error: string };

/** Counts each probe's events since `since`; any count above zero, or any probe that fails, means the review runs. */
export async function readPriorWindow(window: PriorWindow, since: string, run: PlannerRun): Promise<WindowVerdict> {
  const counts: string[] = [];
  for (const [key, label] of PROBES) {
    const [file, ...args] = window[key].map((arg) => arg.replaceAll("{since}", since));
    const result = await run(file!, args);
    if (result.code !== 0) return { kind: "unknown", error: `${key}: exit ${result.code}: ${result.stderr.trim().split("\n")[0] ?? ""}` };
    const count = result.stdout.split("\n").filter((line) => line.trim() !== "").length;
    if (count > 0) return { kind: "active" };
    counts.push(`0 ${label}`);
  }
  return { kind: "quiet", summary: counts.join(", ") };
}

export function appendSkipRecord(reviewDir: string, line: string): void {
  mkdirSync(reviewDir, { recursive: true });
  appendFileSync(join(reviewDir, SKIP_LOG), `${line}\n`);
}
