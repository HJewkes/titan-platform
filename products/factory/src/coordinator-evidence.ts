import { isDeepStrictEqual } from "node:util";
import { checkAgainstJsonSchema, type GateEvidencePolicy, type GateRecord } from "@titan-design/hitl";
import { z } from "zod";
import { escalationReason } from "./shepherd/route-table.js";

/**
 * Owner decision 2026-10-07 (TP-1904), "mechanical only": a coordinator may resolve three gate classes without the
 * owner's presence dialog, each only on evidence read fresh at resolve time and stored on the gate row:
 * an approve-merge at a head a reviewer said MERGE at, with required checks green and the PR mergeable; a main-red
 * acknowledgement or main-frozen unfreeze once a green main commit contains the merge; and an abandon of a gate whose
 * PR is already merged or closed. Every other gate, a visual or seat owner-gate merge, and a round pick stay the owner's.
 */

const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const REPO = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const PR = z.number().int().positive();
const CheckRunFact = z.strictObject({ id: z.number().int().positive(), name: z.string(), conclusion: z.string(), headSha: SHA });

/** What the run behind an approve-merge gate recorded, and the registration and freeze state read beside it. */
const RunFacts = z.strictObject({
  workflow: z.string(),
  repo: REPO,
  pr: PR,
  /** `table/rowId` of the merge decision the run recorded at the gated head. */
  rule: z.string(),
  /** That decision's recorded reason, which names every authority condition that did not hold. */
  reason: z.string(),
  merge: z.string(),
  visualPaths: z.boolean(),
  held: z.boolean(),
  frozen: z.boolean(),
});

const MergeEvidence = z.strictObject({
  kind: z.literal("approve-merge"),
  gateId: z.string(),
  repo: REPO,
  pr: PR,
  headSha: SHA,
  run: RunFacts,
  verdict: z.strictObject({ step: z.string(), verdict: z.string(), head: SHA, reviewer: z.string() }),
  checks: z.strictObject({ base: z.string(), required: z.array(z.string()), runs: z.array(CheckRunFact) }),
  pull: z.strictObject({ state: z.string(), headSha: SHA, mergeableState: z.string(), mergeable: z.string() }),
  readAt: z.string(),
});

const MainGreenEvidence = z.strictObject({
  kind: z.literal("main-green"),
  gateId: z.string(),
  repo: REPO,
  pr: PR,
  mergeSha: SHA,
  base: z.string(),
  greenSha: SHA,
  /** The merge base of the merge sha and the green commit: the merge sha itself when the green commit contains it. */
  mergeBaseSha: SHA,
  runs: z.array(CheckRunFact),
  readAt: z.string(),
});

const PrGoneEvidence = z.strictObject({
  kind: z.literal("pr-gone"),
  gateId: z.string(),
  repo: REPO,
  pr: PR,
  state: z.enum(["merged", "closed"]),
  /** Set for an approve-merge gate, whose abandon is held to the same non-visual rule as its merge. */
  run: RunFacts.optional(),
  readAt: z.string(),
});

export const CoordinatorEvidence = z.discriminatedUnion("kind", [MergeEvidence, MainGreenEvidence, PrGoneEvidence]);
export type CoordinatorEvidence = z.infer<typeof CoordinatorEvidence>;
export type RunFacts = z.infer<typeof RunFacts>;
export type CheckRunFact = z.infer<typeof CheckRunFact>;

export const MERGE_GATE = "approve-merge";
export const MAIN_GATES = { "main-red": "acknowledged", "main-frozen": "unfreeze" } as const;
/** Gates about one PR whose `abandon` a coordinator may give once that PR is merged or closed. */
export const PR_GATES: ReadonlySet<string> = new Set([MERGE_GATE, "stuck-behind", "sh-sent-back", "ci-failed"]);
const PASSING: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);

/** The step id of a gate id: the text after the last `/`, without a repeat suffix `:<n>`. */
export function stepOf(gateId: string): string {
  return gateId.slice(gateId.lastIndexOf("/") + 1).replace(/:\d+$/, "");
}

/** GitHub's REST `mergeable_state` in the GraphQL `mergeable` vocabulary; `behind`, `draft` and anything new are not MERGEABLE. */
export function mergeableOf(mergeableState: string): "MERGEABLE" | "CONFLICTING" | "UNKNOWN" {
  // `blocked` passes because the required checks are verified on their own and the factory's repos require no approvals.
  if (["clean", "unstable", "has_hooks", "blocked"].includes(mergeableState)) return "MERGEABLE";
  return mergeableState === "dirty" ? "CONFLICTING" : "UNKNOWN";
}

const LAND_PROMPT = /^Merge PR #(\d+) in (\S+) at head ([0-9a-f]{40})(?: into \S+)?\? CI is green\. Policy ([\w-]+)\/([\w-]+): (.*)$/;

export interface LandGate {
  repo: string;
  pr: number;
  head: string;
  rule: string;
  /** The decision's reason as the prompt shows it. */
  reason: string;
}

/**
 * A land approve-merge gate: its prompt names the PR, the head and the policy rule, and its schema pins the same head.
 * A conflict or any other approve-merge gate does not read as one.
 */
export function landGate(gate: Pick<GateRecord, "id" | "prompt" | "schema">): LandGate | undefined {
  const match = stepOf(gate.id) === MERGE_GATE ? LAND_PROMPT.exec(gate.prompt) : null;
  if (!match || pinnedHead(gate.schema) !== match[3]) return undefined;
  return { repo: match[2]!, pr: Number(match[1]), head: match[3]!, rule: `${match[4]}/${match[5]}`, reason: match[6]! };
}

function pinnedHead(schema: GateRecord["schema"]): string | undefined {
  const head = (schema?.properties as Record<string, { const?: unknown }> | undefined)?.headSha?.const;
  return typeof head === "string" ? head : undefined;
}

const MAIN_PROMPT = /^Main CI on (\S+) at merge ([0-9a-f]{40}) \(PR #(\d+)\) /;

/** A main-red or main-frozen gate about one merge, whose brief points at that merge's main CI. */
export function mainGate(gate: Pick<GateRecord, "id" | "prompt" | "evidenceRef">): { repo: string; mergeSha: string; pr: number } | undefined {
  const match = Object.hasOwn(MAIN_GATES, stepOf(gate.id)) ? MAIN_PROMPT.exec(gate.prompt) : null;
  if (!match || gate.evidenceRef !== `$ gh run list -R ${match[1]} -c ${match[2]}`) return undefined;
  return { repo: match[1]!, mergeSha: match[2]!, pr: Number(match[3]) };
}

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;
const CI_FAILED_SUMMARY = /^CI failed on ([\w.-]+\/[\w.-]+)#(\d+) at [0-9a-f]{40}\./;

/** The PR a PR gate's brief names: its evidence link, or for a red-CI gate whose link is a check, its summary. */
export function gatePr(gate: Pick<GateRecord, "evidenceRef" | "summary">): { repo: string; pr: number } | undefined {
  const match = PR_URL.exec(gate.evidenceRef ?? "") ?? CI_FAILED_SUMMARY.exec(gate.summary ?? "");
  return match ? { repo: match[1]!, pr: Number(match[2]) } : undefined;
}

export function offersAbandon(gate: Pick<GateRecord, "questions">): boolean {
  return gate.questions?.some((question) => question.id === "decision" && question.options.some((option) => option.id === "abandon")) ?? false;
}

/**
 * Only an MRG-AU gate whose recorded reason the owner classed as mechanical qualifies: authority is decided after every
 * Shepherd guard, so no visual change hides behind it, and the reason names each condition that did not hold. A seat
 * owner-gate, a route escalation, a release or any guard rule stays the owner's.
 */
function runEligible(run: RunFacts, land: LandGate): boolean {
  const matches = run.workflow === "shepherd-pr" && run.repo === land.repo && run.pr === land.pr && run.rule === land.rule && run.reason === land.reason;
  return matches && run.rule === "authority/MRG-AU" && mechanicalAuthorityReason(run.reason) && run.merge === "auto" && !run.held && !run.frozen;
}

const POLICY_DENIAL = escalationReason("policy-denial", "");
const CONDITION_LIST = "[a-z-]+(?:, [a-z-]+)*";
const MRG_AU_REASON = new RegExp(`^MRG-AU gates merge by automation; MRG-AU-RV unmet: (${CONDITION_LIST})(?:; MRG-AU-RC unmet: ${CONDITION_LIST})?(?:; MRG-AU-RM unmet: ${CONDITION_LIST})?$`);
/** Owner decision 2026-10-07: a reviewer MERGE at the head, green required checks and MERGEABLE, each re-read at resolve time. */
const MECHANICAL_CONDITIONS: ReadonlySet<string> = new Set(["verdict-merge-at-head", "required-contexts-green", "no-non-green-run", "merge-tree-clean"]);

/**
 * True only for authority's own wording of an MRG-AU gate whose unmet MRG-AU-RV conditions are all mechanical. Authority
 * lists every condition that fails, so a protected path, a missing seat grant, a frozen repo, a tainted request, facts
 * read closed, or a condition added later never reads as mechanical.
 */
export function mechanicalAuthorityReason(reason: string): boolean {
  const match = reason.startsWith(POLICY_DENIAL) ? MRG_AU_REASON.exec(reason.slice(POLICY_DENIAL.length)) : null;
  return match !== null && match[1]!.split(", ").every((condition) => MECHANICAL_CONDITIONS.has(condition));
}

/**
 * The store's check, re-run over the stored row by any audit: the evidence must name this gate and justify exactly this
 * answer by a coordinator. It reads nothing; `readCoordinatorEvidence` does the fresh reads.
 */
export const coordinatorEvidencePolicy: GateEvidencePolicy = (gate, resolver, payload, raw) => {
  const parsed = CoordinatorEvidence.safeParse(raw);
  if (resolver.class !== "coordinator" || !parsed.success || parsed.data.gateId !== gate.id || !fitsSchema(gate, payload)) return false;
  const evidence = parsed.data;
  if (evidence.kind === "approve-merge") return mergeAdmits(gate, payload, evidence);
  if (evidence.kind === "main-green") return mainGreenAdmits(gate, payload, evidence);
  return prGoneAdmits(gate, payload, evidence);
};

/** The store checks the schema after this policy; refusing here first sends a misfit answer to the dialog rather than to an error. */
function fitsSchema(gate: GateRecord, payload: unknown): boolean {
  return gate.schema !== undefined && checkAgainstJsonSchema(gate.schema, payload).length === 0;
}

type Of<K extends CoordinatorEvidence["kind"]> = Extract<CoordinatorEvidence, { kind: K }>;

function mergeAdmits(gate: GateRecord, payload: unknown, evidence: Of<"approve-merge">): boolean {
  const land = landGate(gate);
  if (!land || !isDeepStrictEqual(payload, { decision: "merge", headSha: land.head })) return false;
  if (evidence.repo !== land.repo || evidence.pr !== land.pr || evidence.headSha !== land.head || !runEligible(evidence.run, land)) return false;
  const { verdict, pull } = evidence;
  const reviewed = verdict.verdict === "MERGE" && verdict.head === land.head && verdict.step === `sh-await-verdict:${land.head}`;
  const mergeable = pull.state === "open" && pull.headSha === land.head && pull.mergeable === "MERGEABLE" && mergeableOf(pull.mergeableState) === "MERGEABLE";
  return reviewed && mergeable && requiredGreen(evidence.checks, land.head);
}

/** Every required context has a successful run at the head; an empty requirement is no evidence of green. */
function requiredGreen(checks: Of<"approve-merge">["checks"], head: string): boolean {
  if (checks.required.length === 0 || checks.runs.length !== checks.required.length) return false;
  return checks.required.every((name) => checks.runs.some((run) => run.name === name && run.headSha === head && run.conclusion === "success"));
}

function mainGreenAdmits(gate: GateRecord, payload: unknown, evidence: Of<"main-green">): boolean {
  const main = mainGate(gate);
  if (!main || !isDeepStrictEqual(payload, { decision: MAIN_GATES[stepOf(gate.id) as keyof typeof MAIN_GATES], mergeSha: main.mergeSha })) return false;
  if (evidence.repo !== main.repo || evidence.pr !== main.pr || evidence.mergeSha !== main.mergeSha || evidence.mergeBaseSha !== main.mergeSha) return false;
  return evidence.runs.length > 0 && evidence.runs.every((run) => run.headSha === evidence.greenSha && PASSING.has(run.conclusion));
}

/** The abandon a gate's schema accepts: one that pins `headSha` gets that head, as its owner answer would. */
function abandonOf(gate: GateRecord): Record<string, unknown> {
  const head = pinnedHead(gate.schema);
  return head === undefined ? { decision: "abandon" } : { decision: "abandon", headSha: head };
}

function prGoneAdmits(gate: GateRecord, payload: unknown, evidence: Of<"pr-gone">): boolean {
  const target = gatePr(gate);
  if (!PR_GATES.has(stepOf(gate.id)) || !offersAbandon(gate) || target?.repo !== evidence.repo || target.pr !== evidence.pr) return false;
  if (stepOf(gate.id) !== MERGE_GATE) return isDeepStrictEqual(payload, abandonOf(gate));
  const land = landGate(gate);
  if (!land || land.repo !== target.repo || land.pr !== target.pr || !evidence.run || !runEligible(evidence.run, land)) return false;
  return isDeepStrictEqual(payload, { decision: "abandon", headSha: land.head });
}
