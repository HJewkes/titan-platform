import type { GateBrief } from "@titan-design/hitl";

/** Copies only the brief's own fields: a brief is structurally typed, so extra keys on it must not reach the gate's id, schema or rule. */
export function briefFields(brief: GateBrief | undefined): Partial<GateBrief> {
  if (!brief) return {};
  const { summary, evidenceRef, questions } = brief;
  return questions === undefined ? { summary, evidenceRef } : { summary, evidenceRef, questions };
}
