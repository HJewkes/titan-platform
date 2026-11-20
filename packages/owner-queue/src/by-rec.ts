import { floorReason, type ByRecSubject } from "./by-rec-floor.js";
import type { ByRecExclusion, ByRecPolicy } from "./by-rec-schema.js";
import type { OwnerItem } from "./schema.js";

export type ByRecDecision =
  | { eligible: true; at: string; answer: string; rationale: string }
  | { eligible: false; reason: string; at?: string };

const HOUR_MS = 3_600_000;
const PREFIX_FIELDS = new Set<ByRecExclusion["field"]>(["hold", "path", "authority"]);

function valuesOf(subject: ByRecSubject, field: ByRecExclusion["field"]): readonly string[] {
  const one = (value: string | undefined): string[] => (value === undefined ? [] : [value]);
  const fields: Record<ByRecExclusion["field"], readonly string[]> = {
    source: [subject.source],
    id: [subject.id],
    class: one(subject.decisionClass),
    hold: subject.holdClasses ?? [],
    category: one(subject.category),
    by: one(subject.recommendation?.by),
    path: subject.paths ?? [],
    authority: subject.authorityRows ?? [],
  };
  return fields[field];
}

function excludedBy(subject: ByRecSubject, policy: ByRecPolicy): ByRecExclusion | undefined {
  return policy.exclude.find((rule) =>
    valuesOf(subject, rule.field).some((value) => (PREFIX_FIELDS.has(rule.field) ? value.startsWith(rule.value) : value === rule.value)),
  );
}

/** The asker's own `apply-default afterHours` wins over the policy's wait. */
function waitHours(subject: ByRecSubject, policy: ByRecPolicy): number {
  return subject.onSilence?.action === "apply-default" ? subject.onSilence.afterHours : policy.afterHours;
}

function belowConfidence(subject: ByRecSubject, policy: ByRecPolicy): boolean {
  if (policy.minConfidence === undefined) return false;
  return (subject.recommendation?.confidence ?? -1) < policy.minConfidence;
}

function policyReason(subject: ByRecSubject, policy: ByRecPolicy): string | undefined {
  if (policy.mode === "off") return "mode-off";
  const floor = floorReason(subject);
  if (floor !== undefined) return `floor:${floor}`;
  const rule = excludedBy(subject, policy);
  if (rule !== undefined) return `excluded:${rule.field}=${rule.value}`;
  return belowConfidence(subject, policy) ? "below-confidence" : undefined;
}

/**
 * Whether a subject resolves to its recommendation now. Pure: the sweep re-reads every fact, calls this, and acts or
 * logs. Shadow mode decides the same way as live; only the sweep's action differs. A skip that is only waiting on the
 * clock carries `at`, so a countdown can show when it becomes eligible.
 */
export function byRecDecision(subject: ByRecSubject, now: Date, policy: ByRecPolicy): ByRecDecision {
  const reason = policyReason(subject, policy);
  if (reason !== undefined) return { eligible: false, reason };
  const opened = Date.parse(subject.openedAt);
  if (Number.isNaN(opened)) return { eligible: false, reason: "bad-opened-at" };
  const at = new Date(opened + waitHours(subject, policy) * HOUR_MS).toISOString();
  if (now.getTime() < Date.parse(at)) return { eligible: false, reason: "too-early", at };
  const recommendation = subject.recommendation ?? { answer: "", by: "" };
  const rationale = recommendation.rationale?.trim() || `recommended by ${recommendation.by}`;
  return { eligible: true, at, answer: recommendation.answer, rationale };
}

/** An owner-queue item (a deposit, or a round question read back) as a by-rec subject. */
export function byRecSubjectOfItem(item: OwnerItem): ByRecSubject {
  const { recommended } = item;
  const system = item.sources[0]?.system;
  return {
    source: system === "round" ? "round" : system === "hitl" ? "gate" : "deposit",
    id: item.id,
    openedAt: item.openedAt,
    summary: item.summary,
    ...(recommended && { recommendation: { answer: recommended.optionId, by: recommended.by, rationale: recommended.rationale, confidence: recommended.confidence } }),
    kind: item.kind,
    door: item.door,
    irreversible: item.irreversible !== undefined,
    onSilence: item.onSilence,
    default: item.default,
    options: item.options?.map((option) => option.id),
    decisionClass: item.class,
    category: item.category,
    op: item.op?.kind,
    audience: item.audience,
    personal: item.personal,
    changeRequested: item.answer?.changeRequested === true,
    blind: recommended?.hidden === true,
    closed: item.status !== "open",
    ship: system === "round" && item.kind === "approve",
    text: [item.summary, item.context, ...(item.options ?? []).flatMap((option) => [option.label, option.description ?? "", option.consequence ?? ""])],
  };
}
