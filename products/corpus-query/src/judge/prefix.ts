import { createHash } from "node:crypto";
import type { QuerySpec } from "../types.js";

export interface PrefixInput {
  role: string;
  question: string;
  spec: QuerySpec;
  /** Owner rulings, copied into the prefix byte for byte. */
  rules?: string;
}

/**
 * The fixed, cacheable system prompt of a wave. Built only from the role, question, the spec's
 * judging fields and the rules, so every batch of a run sends the same bytes. Canaries and the
 * grown lexicon travel in the batch message instead.
 */
export function buildJudgePrefix({ role, question, spec, rules }: PrefixInput): string {
  const judging = {
    entity: spec.entity,
    rowFields: spec.rowFields,
    mode: spec.mode,
    inclusion: spec.inclusion,
    exclusion: spec.exclusion,
  };
  const parts = [
    role,
    "## Dispatch context",
    `### Question\n${question}`,
    `### Query spec\n${JSON.stringify(judging, null, 2)}`,
  ];
  if (rules !== undefined) parts.push(`### Owner rulings\n${rules}`);
  return parts.join("\n\n");
}

export function prefixSha(prefix: string): string {
  return createHash("sha256").update(prefix).digest("hex");
}
