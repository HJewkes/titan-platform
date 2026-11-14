import { readFileSync } from "node:fs";
import { afterAll, beforeAll } from "vitest";
import { overrideWritingGatePolicy, parseWritingGatePolicy, type WritingGatePolicy } from "./writing-gate-policy.js";

/** The shipped `doctrine/writing-gate.json`, parsed fresh so a test may edit its copy. */
export const shippedGatePolicy = (): WritingGatePolicy =>
  parseWritingGatePolicy(readFileSync(new URL("../doctrine/writing-gate.json", import.meta.url), "utf8"));

/** The shipped policy with every gate and hallmark row report-only: the rows still print, and none fails. */
function reportOnlyGatePolicy(): WritingGatePolicy {
  const policy = shippedGatePolicy();
  for (const rows of [policy.gate, policy.hallmarks]) for (const row of Object.values(rows)) row.severity = "report-only";
  return policy;
}

/**
 * Runs the calling file with every writing gate row report-only, so its tests of the calibrated rows (TP-4662) are not
 * moved by the gate (TP-5721). The explainer project shares one module graph per worker, so the override is undone.
 */
export function useReportOnlyGate(): void {
  beforeAll(() => overrideWritingGatePolicy(reportOnlyGatePolicy()));
  afterAll(() => overrideWritingGatePolicy(undefined));
}
