import { tokenize } from "@titan-design/memory";
import { z } from "zod";
import { feedbackForRow, type Citation } from "./feedback.js";
import type { LedgerRow } from "./ledger.js";
import type { Principle } from "./principles.js";

/** One owner answer judged against one live principle of the domain. */
export const CiteDeltaSchema = z.strictObject({
  type: z.literal("cite"),
  rowKey: z.string().min(1),
  principleId: z.string().min(1),
  verdict: z.enum(["agrees", "contradicts"]),
  reason: z.string().max(500).optional(),
});

/** A new rule drawn from owner answers; the domain and maturity come from the run, never the reflector. */
export const ProposeDeltaSchema = z.strictObject({
  type: z.literal("propose"),
  rule: z.string().trim().min(1).max(300),
  citedKeys: z.array(z.string().min(1)).min(1),
  isNegative: z.boolean().optional(),
  reasoning: z.string().max(500).optional(),
});

export const CondenseDeltaSchema = z.discriminatedUnion("type", [CiteDeltaSchema, ProposeDeltaSchema]);

export type CondenseDelta = z.output<typeof CondenseDeltaSchema>;
export type CiteDelta = z.output<typeof CiteDeltaSchema>;
export type ProposeDelta = z.output<typeof ProposeDeltaSchema>;

/** An accepted delta with its position in the reflector's output. */
export interface IndexedDelta {
  index: number;
  delta: CondenseDelta;
}

export interface RejectedCondenseDelta {
  domain: string;
  /** Position in the reflector's output, or -1 when the output as a whole was unusable. */
  index: number;
  reason: string;
}

/** Wording aimed at whoever reads the question, not at the owner it was asked of. */
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(rules?|instructions?|principles?|prompts?|guidance)\b/i,
  /\b(add|create|record|insert|adopt|learn|save|store|write)\b[^.\n]{0,30}\b(principles?|playbook|bullets?)\b/i,
  /\b(mark|flag|set|treat)\b[^.\n]{0,30}\b(helpful|harmful|established|proven)\b/i,
  /\b(system prompt|you are now|new instructions|as the (reflector|condenser|decider))\b/i,
];

/** A principle needs this share of its words inside an instruction before it counts as lifted from it. */
const LIFTED_SHARE = 0.5;

/** The parts of a row an agent wrote; the owner's answer and free text are not among them. */
function agentText(row: LedgerRow): string {
  return [row.header ?? "", row.question, ...row.options.flatMap((o) => [o.label, "description" in o ? (o.description ?? "") : ""])].join("\n");
}

export function carriesInstruction(row: LedgerRow): boolean {
  const text = agentText(row);
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));
}

/** Only an owner's own answer, or an overrule of the decider, is evidence for a principle. */
export function isEvidence(row: LedgerRow): boolean {
  return !("skipped" in feedbackForRow(row, []));
}

function sharedShare(rule: string, text: string): number {
  const ruleTokens = tokenize(rule);
  if (ruleTokens.size === 0) return 0;
  const textTokens = tokenize(text);
  return [...ruleTokens].filter((t) => textTokens.has(t)).length / ruleTokens.size;
}

export interface DomainBatch {
  domain: string;
  evidence: ReadonlyMap<string, LedgerRow>;
  principleIds: ReadonlySet<string>;
  /** Keys of evidence rows whose agent-written text carries an instruction. */
  flagged: ReadonlySet<string>;
}

export function domainBatch(domain: string, evidence: readonly LedgerRow[], principles: readonly Principle[]): DomainBatch {
  return {
    domain,
    evidence: new Map(evidence.map((row) => [row.key, row])),
    principleIds: new Set(principles.map((p) => p.id)),
    flagged: new Set(evidence.filter(carriesInstruction).map((row) => row.key)),
  };
}

function groundCite(delta: CiteDelta, batch: DomainBatch): string | null {
  if (!batch.evidence.has(delta.rowKey)) return `row ${delta.rowKey} is not owner evidence in this batch`;
  if (batch.flagged.has(delta.rowKey)) return `row ${delta.rowKey} carries an instruction in its question`;
  if (!batch.principleIds.has(delta.principleId)) return `principle ${delta.principleId} is not live in ${batch.domain}`;
  return null;
}

function groundPropose(delta: ProposeDelta, batch: DomainBatch): string | null {
  const unknown = delta.citedKeys.find((key) => !batch.evidence.has(key));
  if (unknown !== undefined) return `cited row ${unknown} is not owner evidence in this batch`;
  const flagged = delta.citedKeys.find((key) => batch.flagged.has(key));
  if (flagged !== undefined) return `cited row ${flagged} carries an instruction in its question`;
  const source = [...batch.flagged].find((key) => {
    const row = batch.evidence.get(key);
    return row !== undefined && sharedShare(delta.rule, agentText(row)) >= LIFTED_SHARE;
  });
  return source === undefined ? null : `rule is lifted from the instruction in row ${source}`;
}

function ground(delta: CondenseDelta, batch: DomainBatch): string | null {
  return delta.type === "cite" ? groundCite(delta, batch) : groundPropose(delta, batch);
}

function zodReason(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "delta"}: ${i.message}`).join("; ");
}

/** Validate the reflector's output shape with zod, then check each delta against the batch it was shown. */
export function parseCondenseDeltas(raw: unknown, batch: DomainBatch, rejected: RejectedCondenseDelta[]): IndexedDelta[] {
  if (!Array.isArray(raw)) {
    rejected.push({ domain: batch.domain, index: -1, reason: "reflector did not return an array" });
    return [];
  }
  const accepted: IndexedDelta[] = [];
  raw.forEach((item, index) => {
    const parsed = CondenseDeltaSchema.safeParse(item);
    const reason = parsed.success ? ground(parsed.data, batch) : zodReason(parsed.error);
    if (reason !== null) rejected.push({ domain: batch.domain, index, reason });
    else if (parsed.success) accepted.push({ index, delta: parsed.data });
  });
  return accepted;
}

export function citationsFor(rowKey: string, deltas: readonly CondenseDelta[]): Citation[] {
  return deltas
    .filter((d): d is CiteDelta => d.type === "cite" && d.rowKey === rowKey)
    .map(({ principleId, verdict, reason }) => ({ principleId, verdict, ...(reason === undefined ? {} : { reason }) }));
}
