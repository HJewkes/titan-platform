import type { CheckSpec } from "../spec/index.js";

/** Read-only trial: the tools the variant disallows must also be absent from the trace. */
const DENIED_TOOLS = ["Write", "Edit", "Bash(git push:*)", "Bash(gh:*)"];

/**
 * The deterministic and metric checks of design 8.1 for every review-pr suite. Judge criteria arrive with their
 * calibrated prompts (TP-692), so they are not listed here.
 */
export const REVIEW_PR_CHECKS: readonly CheckSpec[] = [
  { id: "output-shape", family: "deterministic", role: "required", scope: "trial", critical: true, type: "output.schema", params: { from: "unit.output" } },
  { id: "closing-head", family: "deterministic", role: "required", scope: "trial", critical: true, type: "output.regex", params: { closingLine: "Head", equals: "input.head" } },
  { id: "verdict", family: "deterministic", role: "scored", scope: "trial", type: "label.equals", params: { output: "verdict", expected: "verdict" } },
  { id: "read-only", family: "deterministic", role: "required", scope: "trial", critical: true, type: "trace.tool_absent", params: { tools: DENIED_TOOLS } },
  { id: "read-changed-file", family: "deterministic", role: "required", scope: "trial", type: "trace.file_read", params: { anyOf: "bundle.diff.paths", min: 1 } },
  { id: "citations-resolve", family: "deterministic", role: "required", scope: "trial", type: "citation.verified", params: { findings: "blocking", at: "bundle.head" } },
  { id: "fix-proof", family: "deterministic", role: "reported", scope: "trial", type: "fix_proof", params: { when: "head adds tests" } },
  { id: "cost", family: "metric", role: "reported", scope: "trial", metric: "cost_usd" },
  { id: "turns", family: "metric", role: "reported", scope: "trial", metric: "turns" },
  { id: "wall-time", family: "metric", role: "reported", scope: "trial", metric: "wall_ms" },
  { id: "tokens-in", family: "metric", role: "reported", scope: "trial", metric: "tokens_in" },
  { id: "tokens-out", family: "metric", role: "reported", scope: "trial", metric: "tokens_out" },
];
