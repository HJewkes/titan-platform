import { z } from "zod";
import { count, modelId, nonempty, objectFor, promptRef, specId, usd } from "./common.js";
import type { SpecParseMode } from "./common.js";

export const CHECK_ROLES = ["required", "scored", "reported"] as const;

export const EFFICIENCY_METRICS = [
  "wall_ms", "machine_ms", "human_wait_ms",
  "cost_usd", "tokens_in", "tokens_out", "tokens_cache_read",
  "turns", "tool_calls", "tool_errors",
  "attempts", "retries", "step_failures",
  "context_at_first_deliverable", "gates_opened", "owner_words",
  "cpu_peak", "rss_peak", "cpu_avg",
] as const;

export const DETERMINISTIC_CHECK_TYPES = [
  "output.schema", "output.regex", "output.contains", "label.equals",
  "file.exists", "file.regex", "diff.scope", "command", "hidden_tests", "fix_proof",
  "citation.verified", "trace.tool_called", "trace.tool_absent", "trace.skill_loaded",
  "trace.file_read", "trace.order", "gate.count", "gate.asked", "signal.equals",
] as const;

/** `scope` is "trial" or a step id or sub-unit prefix, so a check can apply to one step. */
const base = {
  id: specId,
  role: z.enum(CHECK_ROLES),
  scope: nonempty.default("trial"),
  critical: z.boolean().optional(),
};

function judgeCheck(mode: SpecParseMode) {
  const object = objectFor(mode);
  const binary = object({ id: specId, question: nonempty, scale: z.literal("binary"), weight: z.number().positive() });
  const graded = object({
    id: specId, question: nonempty, scale: z.literal("1-5"), weight: z.number().positive(),
    anchors: object({ "1": nonempty, "3": nonempty, "5": nonempty }),
  });
  return object({
    ...base,
    family: z.literal("judge"),
    role: z.enum(["scored", "reported"]),
    mode: z.enum(["absolute", "pairwise"]),
    judge: object({ model: modelId(mode), prompt: promptRef(mode), maxBudgetUsd: usd }),
    criteria: z.array(z.discriminatedUnion("scale", [binary, graded])).min(1),
    evidenceRequired: z.boolean(),
    controls: object({ perBatch: count, pool: nonempty }),
  });
}

export function checkSchema(mode: SpecParseMode) {
  const object = objectFor(mode);
  const metric = object({
    ...base,
    family: z.literal("metric"),
    metric: z.enum(EFFICIENCY_METRICS),
    min: z.number().optional(),
    max: z.number().optional(),
  });
  const deterministic = object({
    ...base,
    family: z.literal("deterministic"),
    type: z.enum(DETERMINISTIC_CHECK_TYPES),
    params: z.record(z.string(), z.unknown()),
  });
  return z.discriminatedUnion("family", [metric, deterministic, judgeCheck(mode)]);
}
