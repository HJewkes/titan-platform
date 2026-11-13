import { z } from "zod";
import { BET_ID_REGEX, FOLD_ID_REGEX, OUTCOME_ID_REGEX, TASK_ID_REGEX } from "./ids.js";

/*
 * Task provenance (TP-5446 plan, section 3.1, F1-F9): where a task came from and why it closed, recorded when the task
 * is filed so the ticket scorecard stops inferring it. Every field is optional on read, so task files written before
 * these fields still parse; an initiative's brief makes some of them required on new tasks through `task_require`
 * (enforced by active-work, not here).
 *
 * Adding a field: put it in `TaskProvenanceShape`. Its `field_origin` key follows from the shape. If the filer may be
 * made to supply it, list it in `TASK_REQUIRABLE_FIELDS` too.
 */

const TASK_CLASSES = ["product", "upkeep"] as const;

const TASK_SOURCES = ["owner", "plan", "follow-up", "review", "sweep", "audit", "coordinator", "incident"] as const;

const TASK_RANKS = ["p0", "p1", "p2", "p3"] as const;

const DONE_REASONS = ["shipped", "superseded", "duplicate", "moot", "wont-do"] as const;

const BLOCKERS = ["owner", "decision", "task", "external"] as const;

const OWNER_STEP_KINDS = ["release", "restart", "credential", "sitting", "config", "publish"] as const;

const closedSet = <const T extends readonly [string, ...string[]]>(field: string, values: T) =>
  z.enum(values, { error: `${field} must be one of: ${values.join(", ")}` });

const SERVES_NONE = "none";

/** An outcome id in the planning `Outcome` format, or `none` for a task that serves no outcome. */
const serves = z.union([z.literal(SERVES_NONE), z.string().regex(OUTCOME_ID_REGEX)], {
  error: `serves must be an outcome id (alpha/faster-landing) or ${SERVES_NONE}`,
});

/** A bet id in the planning `Bet` format. Whether the bet exists is checked at write, through a `BetLookup`. */
const bet = z.string().regex(BET_ID_REGEX, { error: "bet must be a bet id (alpha/B1)" });

const FOLD_INDEPENDENT = "independent";

/** `independent` for a task that lands on its own, or the id of the fold it must land with. */
const fold = z.union([z.literal(FOLD_INDEPENDENT), z.string().regex(FOLD_ID_REGEX)], {
  error: `fold must be a fold id (alpha/FD1) or ${FOLD_INDEPENDENT}`,
});

/** A step only the owner can take, listed up front so an agent never starts a task it cannot finish. */
const OwnerStepSchema = z.strictObject({
  kind: closedSet("owner_steps kind", OWNER_STEP_KINDS),
  note: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]*$/, { message: "owner_steps note must be one line" }),
});

const PR_REF_REGEX = /^[\w.-]+\/[\w.-]+#\d+$/;

/** The PR and task a follow-up or review finding came from. */
const FromPrRefSchema = z.strictObject({
  from_pr: z.string().regex(PR_REF_REGEX, { message: "from_pr must look like owner/repo#12" }),
  from_task: z.string().regex(TASK_ID_REGEX, { message: "from_task must be a task id (e.g. AL-1)" }),
  head: z.string().regex(/^[0-9a-f]{40}$/, { message: "head must be a 40-hex commit sha" }).optional(),
});

const sourceRef = z.union([z.string().trim().min(1), FromPrRefSchema]);

/** A single token, so a sentence cannot stand in for the decision or owner-queue item id. */
const OWNER_REF_REGEX = /^[A-Za-z0-9][\w.:/#-]*$/;

const PLAN_REF_REGEX = /^[^\s#]+#[^\s#]+$/;

const agentName = z.string().regex(/^[A-Za-z0-9][\w.-]*$/, { message: "filed_by must be an agent name or owner" });

const ORIGIN_REGEX = /^(filed|owner|audit|inferred:[a-z0-9][a-z0-9.-]*)$/;

/** Who set a provenance value: the filer, the owner, the audit set, or a named backfill heuristic. */
const fieldOrigin = z.string().regex(ORIGIN_REGEX, {
  message: "field_origin values must be filed, owner, audit or inferred:<heuristic-id>",
});

const TaskProvenanceShape = {
  class: closedSet("class", TASK_CLASSES).optional(),
  serves: serves.optional(),
  source: closedSet("source", TASK_SOURCES).optional(),
  source_ref: sourceRef.optional(),
  filed_by: agentName.optional(),
  rank: closedSet("rank", TASK_RANKS).optional(),
  done_reason: closedSet("done_reason", DONE_REASONS).optional(),
  blocked_on: closedSet("blocked_on", BLOCKERS).optional(),
  bet: bet.optional(),
  fold: fold.optional(),
  owner_steps: z.array(OwnerStepSchema).optional(),
};

type ProvenanceField = keyof typeof TaskProvenanceShape;

const FieldOriginSchema = z.partialRecord(z.object(TaskProvenanceShape).keyof(), fieldOrigin);

/** The task fields spread into `TaskSchema`; `field_origin` maps any of the others to who set it. */
export const taskProvenanceFields = { ...TaskProvenanceShape, field_origin: FieldOriginSchema.optional() };

/** The fields an initiative's brief may require on new tasks through `task_require`. */
const TASK_REQUIRABLE_FIELDS = ["class", "serves", "source", "source_ref"] as const satisfies readonly ProvenanceField[];

/** A brief's `task_require`: the provenance fields every task filed in that initiative must carry. */
export const TaskRequireSchema = z
  .array(closedSet("task_require entries", TASK_REQUIRABLE_FIELDS))
  .refine((fields) => new Set(fields).size === fields.length, { message: "task_require entries must be unique" });

export type TaskRequire = z.infer<typeof TaskRequireSchema>;

type SourceFields = { source?: (typeof TASK_SOURCES)[number]; source_ref?: z.infer<typeof sourceRef> };

const isText = (ref: SourceFields["source_ref"]): ref is string => typeof ref === "string";

/** Why a task's `source_ref` does not fit its `source`, or null when it fits. */
export function sourceRefProblem({ source, source_ref: ref }: SourceFields): string | null {
  if (source === undefined) return ref === undefined ? null : "source_ref needs a source";
  if (source === "owner") {
    return isText(ref) && OWNER_REF_REGEX.test(ref) ? null : "source owner needs a decision or owner-queue item id";
  }
  if (ref === undefined) return null;
  if (source === "follow-up" || source === "review") return isText(ref) ? `source ${source} needs from_pr and from_task` : null;
  if (!isText(ref)) return "only follow-up and review take a from_pr reference";
  return source === "plan" && !PLAN_REF_REGEX.test(ref) ? "source plan needs path#slice" : null;
}

/** Answers whether a bet id names a bet that exists. The planning store (TP-5453 P3) provides the real one. */
export interface BetLookup {
  has(betId: string): Promise<boolean>;
}

/** Why a task's `bet` cannot be written, or null when it names no bet or a bet that exists. */
export async function betProblem({ bet: betId }: { bet?: string }, lookup: BetLookup): Promise<string | null> {
  if (betId === undefined) return null;
  return (await lookup.has(betId)) ? null : `Unknown bet id: ${betId}`;
}
