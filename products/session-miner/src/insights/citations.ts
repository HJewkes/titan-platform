import { z } from "zod";

const citedValue = z.union([z.number(), z.string(), z.boolean(), z.null()]);

const citationSchema = z
  .object({
    question: z.string().min(1).describe("a registered insight name, such as spend-by-action"),
    args: z.record(z.string(), z.unknown()).default({}).describe("the question's CLI flags as an object, such as { since, agent-prefix }"),
    field: z.string().regex(/^(\/.*)?$/, "expected a JSON pointer").describe("a JSON pointer into the answer, such as /totals/sessions"),
    value: citedValue.describe("the value the finding read at field"),
    tolerance: z.number().nonnegative().optional().describe("relative tolerance for a number; 0.01 when omitted"),
  })
  .strict();

/** One analyst finding: a claim, the re-runnable numbers it rests on, and what would prove it wrong. */
export const findingSchema = z
  .object({
    id: z.string().min(1),
    claim: z.string().min(1),
    citations: z.array(citationSchema).min(1, "a finding cites at least one question"),
    falsifier: z.string().trim().min(1, "a finding names what would falsify it"),
  })
  .strict();

export type Citation = z.infer<typeof citationSchema>;
export type Finding = z.infer<typeof findingSchema>;

const CITATION_STATUSES = ["ok", "mismatch", "missing-field", "unknown-question", "error"] as const;

const DEFAULT_TOLERANCE = 0.01;

const citationCheckSchema = citationSchema.extend({
  status: z.enum(CITATION_STATUSES),
  /** The value the re-run found at `field`; absent when the field, question or run is missing. */
  actual: z.unknown().optional(),
  /** Why a run failed, for status `error`. */
  detail: z.string().optional(),
});

export const citationReportSchema = z.object({
  ok: z.boolean(),
  findings: z.array(z.object({ id: z.string(), ok: z.boolean(), citations: z.array(citationCheckSchema) })),
});

export type CitationCheck = z.infer<typeof citationCheckSchema>;
export type CitationReport = z.infer<typeof citationReportSchema>;

/** Re-runs one question; `undefined` means no question has that name. */
export type CitationRunner = (question: string, args: Record<string, unknown>) => Promise<{ answer: unknown } | undefined>;

type RunOutcome = { answer: unknown } | { unknown: true } | { error: string };

/** Re-run every cited question once per distinct question and args, and compare each cited field. */
export async function verifyCitations(findings: readonly Finding[], run: CitationRunner): Promise<CitationReport> {
  const runs = new Map<string, Promise<RunOutcome>>();
  const outcome = (citation: Citation): Promise<RunOutcome> => {
    const key = runKey(citation);
    if (!runs.has(key)) runs.set(key, settle(run(citation.question, citation.args)));
    return runs.get(key)!;
  };
  const checked = await Promise.all(
    findings.map(async (finding) => {
      const citations = await Promise.all(finding.citations.map(async (citation) => checkCitation(citation, await outcome(citation))));
      return { id: finding.id, ok: citations.every((c) => c.status === "ok"), citations };
    }),
  );
  return { ok: checked.every((f) => f.ok), findings: checked };
}

async function settle(pending: Promise<{ answer: unknown } | undefined>): Promise<RunOutcome> {
  try {
    return (await pending) ?? { unknown: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function checkCitation(citation: Citation, outcome: RunOutcome): CitationCheck {
  if ("unknown" in outcome) return { ...citation, status: "unknown-question" };
  if ("error" in outcome) return { ...citation, status: "error", detail: outcome.error };
  const found = resolvePointer(outcome.answer, citation.field);
  if (!found.present) return { ...citation, status: "missing-field" };
  const status = matches(citation.value, found.value, citation.tolerance ?? DEFAULT_TOLERANCE) ? "ok" : "mismatch";
  return { ...citation, status, actual: found.value };
}

/** Numbers match within a tolerance relative to the cited value; anything else matches exactly. */
function matches(cited: unknown, actual: unknown, tolerance: number): boolean {
  if (typeof cited === "number" && typeof actual === "number") return Math.abs(actual - cited) <= tolerance * Math.abs(cited);
  return Object.is(cited, actual);
}

/** RFC 6901: "" is the whole document, and ~1 and ~0 unescape to / and ~. */
function resolvePointer(document: unknown, pointer: string): { present: true; value: unknown } | { present: false } {
  if (pointer === "") return { present: true, value: document };
  let node = document;
  for (const token of pointer.slice(1).split("/").map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, token)) return { present: false };
    node = Reflect.get(node, token);
  }
  return { present: true, value: node };
}

function runKey(citation: Citation): string {
  return JSON.stringify([citation.question, Object.entries(citation.args).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);
}
