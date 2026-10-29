import { z } from "zod";
import { EvidenceSpanSchema } from "../repo-explainer/schemas.js";

export const PR_FACT_KINDS = ["pr", "change", "finding", "call"] as const;

/** The pr-overview block each fact kind feeds; `call` facts fill the sequence slot of `interactions`. */
export const PR_FACT_SLOTS = { pr: "summary", change: "changes", finding: "shortcomings", call: "interactions" } as const satisfies Record<
  (typeof PR_FACT_KINDS)[number],
  string
>;

const Count = z.number().int().min(0);

/** One line of a PR's `facts.jsonl`; the id is derived from content, so two gathers of one head give the same ids. */
export const PrFactSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(PR_FACT_KINDS),
  slot: z.enum(["summary", "changes", "shortcomings", "interactions"]),
  text: z.string().min(1),
  evidence: z.array(EvidenceSpanSchema),
  path: z.string().min(1).optional(),
  status: z.enum(["added", "deleted", "renamed", "modified"]).optional(),
  additions: Count.optional(),
  deletions: Count.optional(),
  task: z.string().optional(),
  head: z.string().optional(),
  verdict: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  sites: Count.optional(),
});
export type PrFact = z.infer<typeof PrFactSchema>;
export type PrFactKind = PrFact["kind"];
