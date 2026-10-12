import type { AgentIdentity } from "@titan-design/authority";
import { DEFECT_CLASS_HEADING, FINDINGS_SEPARATOR, OVERLAY_SHAPES, aggregate, type AggregateInput, type AwaitVerdictInput, type MemberResult, type OverlayShape, type PanelPlan, type PanelPolicy, type PanelVerdict, type ReviewTarget, type ReviewerAgent } from "@titan-design/review-panel";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { AWAIT_VERDICT_STEP } from "./await-verdict.js";
import type { PanelMerge, ShepherdDeps, Verdict } from "./phases.js";
import { classRulesFor, intentPlan, panelFacts, panelPolicyFor, withoutPlan, type IntentPlan, type PanelMode } from "./review-panel-plan.js";
import { Awaited, Dispatched } from "./review-schemas.js";
import { REVIEW_STEP } from "./review-steps.js";
import type { ReviewerRoles } from "./reviewer-roles.js";
import { takeAwaited, verdictOf, type AwaitedResult } from "./take-verdict.js";

/** Records the aggregate once, so a replay reads the verdict the panel gave rather than one recomputed over source that has since moved. */
const PANEL_VERDICT_STEP = "sh-review-panel";
export const PANEL_STEPS: readonly StepDeclaration[] = [{ id: PANEL_VERDICT_STEP, kind: "dispatch" }];

/** At most this many cited files are read at the head to confirm advisory findings; the rest read as missing. */
const MAX_CITED_FILES = 20;
/** The citation form aggregate checks: `path/to/file.ext:line`. */
const CITED_PATH = /(?<![\w./-])((?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z]\w*):\d+/g;

type Intent = { kind: "intent"; plan?: { members: readonly { shape: string; profile: string }[] }; panel?: "on"; panelReviewers?: Record<string, string> } & Record<string, unknown>;
/** An intent recorded under `review.panel` on: one recorded before the flag, or under off or shadow, reviews with one reviewer. */
type PanelIntent = Intent & Required<Pick<Intent, "plan" | "panelReviewers">> & { panel: "on" };

export const panelOn = (intent: Intent): intent is PanelIntent => intent.panel === "on" && intent.plan !== undefined && intent.panelReviewers !== undefined;

const isOverlay = (shape: string): shape is OverlayShape => (OVERLAY_SHAPES as readonly string[]).includes(shape);

/** A name under `base` that neither the roster nor an earlier member holds, so a member is never confused with an earlier agent. */
function unusedName(base: string, taken: Set<string>): string {
  for (let k = 1; ; k += 1) {
    const name = k === 1 ? base : `${base}-${k}`;
    if (!taken.has(name)) return name;
  }
}

/** Each member's name but correctness's, by shape: the correctness reviewer's name with the shape as a suffix. Recorded on the intent so a repeat spawns the same names. */
export function panelReviewerNames(reviewer: string, plan: Pick<PanelPlan, "members">, roster: readonly ReviewerAgent[]): Record<string, string> {
  const taken = new Set([reviewer, ...roster.map((agent) => agent.name)]);
  const names = plan.members.filter((member) => isOverlay(member.shape)).map((member) => {
    const name = unusedName(`${reviewer}-${member.shape}`, taken);
    taken.add(name);
    return [member.shape, name] as const;
  });
  return Object.fromEntries(names);
}

/** Under `on` the intent also names each member but correctness, so a repeat spawns the same names. */
export type PanelOnPlan = IntentPlan & { panel: "on"; panelReviewers: Record<string, string> };

interface PanelWiring {
  panel?: PanelMode;
  panelPolicy?: PanelPolicy;
  roles?: ReviewerRoles;
}

/**
 * Under `shadow` or `on` the intent records the head's class, touches and panel plan; an external review starts nobody, so it gets none.
 * Under `on` it also names the members, so the review phase knows to run them.
 */
export async function plannedPanel(deps: Pick<ShepherdDeps, "store" | "port">, { panel, panelPolicy, roles }: PanelWiring, input: ReviewTarget & { runId: string; reviewer: string }, roster: readonly ReviewerAgent[]): Promise<IntentPlan | PanelOnPlan | undefined> {
  if (panel === undefined || panel === "off") return undefined;
  const rules = classRulesFor(roles);
  const target = { repo: input.repo, pr: input.pr, head: input.head };
  const planned = intentPlan(await panelFacts(deps, target, input.runId, rules), panelPolicy ?? panelPolicyFor(roles), undefined, rules);
  return panel === "on" ? { ...planned, panel: "on", panelReviewers: panelReviewerNames(input.reviewer, planned.plan, roster) } : planned;
}

/** What every member's dispatch shares with the correctness reviewer's; members never write the owner brief. */
export interface MemberBase extends ReviewTarget {
  runId: string;
  fixFirsts?: number;
  fixProof?: string;
}

interface DispatchedMember {
  shape: OverlayShape;
  dispatched: z.infer<typeof Dispatched>;
}

/** A member is always spawned fresh, whatever the correctness reviewer's mode, so it carries no agent id to resume. */
function memberIntent(intent: PanelIntent, reviewer: string): Record<string, unknown> {
  const fields = Object.entries(withoutPlan(intent)).filter(([key]) => key !== "agentId");
  return { ...Object.fromEntries(fields), reviewer, mode: "spawn" };
}

/** One `sh-review:<head>:<shape>` per member but correctness, in plan order, each at its planned profile and with its shape's brief. */
async function dispatchMembers(ctx: WorkflowContext, intent: PanelIntent, base: MemberBase): Promise<DispatchedMember[]> {
  const members: DispatchedMember[] = [];
  for (const { shape, profile } of intent.plan.members) {
    const reviewer = intent.panelReviewers[shape];
    if (!isOverlay(shape) || reviewer === undefined) continue;
    const input = { ...base, intent: memberIntent(intent, reviewer), shape, profile };
    members.push({ shape, dispatched: await step(ctx, `${REVIEW_STEP}:${base.head}:${shape}`, input, Dispatched) });
  }
  return members;
}

/** A recorded await as aggregate reads it: the verdict's own fields, or no verdict. */
function memberResultOf(awaited: AwaitedResult): MemberResult["result"] {
  if (awaited.kind !== "verdict") return { kind: "none", ...(typeof awaited.reason === "string" && { reason: awaited.reason }) };
  const verdict = { kind: "verdict" as const, head: awaited.head, locator: awaited.locator, reviewer: awaited.reviewer };
  if (awaited.verdict === "MERGE") return { ...verdict, verdict: "MERGE" };
  const closer = awaited.closer === "yes" || awaited.closer === "no" ? awaited.closer : undefined;
  return { ...verdict, verdict: "FIX_FIRST", text: awaited.text ?? "", ...(closer !== undefined && { closer }) };
}

/** One `sh-await-verdict:<head>:<shape>` per started member; a member that never started gave no verdict. */
async function awaitMembers(ctx: WorkflowContext, target: ReviewTarget, members: readonly DispatchedMember[]): Promise<MemberResult[]> {
  const results: MemberResult[] = [];
  for (const { shape, dispatched } of members) {
    if (dispatched.kind !== "dispatched") {
      results.push({ shape, result: { kind: "none" } });
      continue;
    }
    const awaiting = { ...target, shape, reviewerAgentId: dispatched.agentId, reviewerSessionId: dispatched.sessionId, dispatchedAt: dispatched.at, ...(dispatched.startedAt !== undefined && { startedAt: dispatched.startedAt }) };
    results.push({ shape, result: memberResultOf(await step(ctx, `${AWAIT_VERDICT_STEP}:${target.head}:${shape}`, awaiting, Awaited)) });
  }
  return results;
}

const SHAPE = z.enum(["correctness", "adversary", "tests", "visual", "perf"]);
const TOUCH = z.enum(["authority", "policy", "migration", "visual", "security", "perf", "dependency", "untested", "large"]);
const PanelPlanSchema = z.object({
  class: z.object({ class: z.enum(["g10", "standard"]), touches: z.array(TOUCH) }),
  members: z.array(z.object({ shape: SHAPE, profile: z.string(), briefId: z.string(), blocking: z.boolean(), degraded: z.boolean() })),
  spendEstimate: z.number(),
  degraded: z.boolean(),
});
const RESULT_KINDS: ReadonlySet<string> = new Set(["verdict", "none", "timeout"]);
const RecordedMemberSchema = z.looseObject({ shape: SHAPE, result: z.looseObject({ kind: z.string() }), degraded: z.boolean().optional() });
type RecordedMember = z.infer<typeof RecordedMemberSchema>;

/** aggregate reads each result as stored JSON and counts only an exact verdict at the head, so a known kind is all it needs here. */
const isMemberResult = (member: RecordedMember): member is RecordedMember & MemberResult => RESULT_KINDS.has(member.result.kind);
const PanelInputSchema = z.object({
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  head: z.string().min(1),
  plan: PanelPlanSchema,
  results: z.array(RecordedMemberSchema),
  fixProof: z.string().optional(),
});
const PanelVerdictRead = z.looseObject({
  outcome: z.enum(["MERGE", "FIX_FIRST", "no-verdict", "timeout"]),
  head: z.string(),
  findings: z.array(z.looseObject({ shape: SHAPE, text: z.string(), blocking: z.boolean() })),
  defectClass: z.string().optional(),
  closer: z.enum(["yes", "no"]).optional(),
  dissent: z.array(SHAPE),
  degraded: z.array(SHAPE),
  satisfiesG10: z.boolean(),
});
type PanelVerdictRecord = z.infer<typeof PanelVerdictRead>;

/** The files the members' FIX_FIRST findings cite, read at the head; a file that cannot be read is missing, which drops only advisory findings. */
async function citedSource(deps: Pick<ShepherdDeps, "port">, { repo, head }: ReviewTarget, results: readonly MemberResult[]): Promise<AggregateInput["source"]> {
  const texts = results.flatMap(({ result }) => ("text" in result && typeof result.text === "string" ? [result.text] : []));
  const paths = [...new Set(texts.flatMap((text) => [...text.matchAll(CITED_PATH)].map((match) => match[1] ?? "")))].slice(0, MAX_CITED_FILES);
  const read = await Promise.all(paths.map(async (path) => [path, await deps.port.getFile(repo, path, head).catch(() => null)] as const));
  const files = new Map(read.flatMap(([path, file]) => (file === null ? [] : [[path, file.content.split(/\r?\n/)] as const])));
  return { lines: (path) => files.get(path) };
}

/** The aggregate over a recorded plan and member results, with cited files read at the head. */
export async function aggregatePanel(deps: Pick<ShepherdDeps, "port">, raw: unknown): Promise<PanelVerdict> {
  const { plan, results, fixProof, ...target } = PanelInputSchema.parse(raw);
  const members: MemberResult[] = results.filter(isMemberResult);
  return aggregate(plan, members, { head: target.head, source: await citedSource(deps, target, members), ...(fixProof !== undefined && { fixProof }) });
}

export const panelVerdictRoute = (deps: Pick<ShepherdDeps, "port" | "now">): StepRoute => codeRoute(PANEL_VERDICT_STEP, deps.now, (raw: unknown) => aggregatePanel(deps, raw));

/** The panel's verdict for one head over every member's recorded result. */
function panelVerdict(ctx: WorkflowContext, target: ReviewTarget, plan: PanelIntent["plan"], results: readonly MemberResult[], fixProof: string | undefined): Promise<PanelVerdictRecord> {
  return step(ctx, `${PANEL_VERDICT_STEP}:${target.head}`, { ...target, plan, results, ...(fixProof !== undefined && { fixProof }) }, PanelVerdictRead);
}

/**
 * Each member's findings under its shape. The aggregate's defect class goes last, under the heading the fixer's structural
 * brief reads the newest of, so a member's own section cannot stand in for the panel's.
 */
export function panelFindingsText(verdict: PanelVerdict): string {
  const sections = verdict.findings.map(({ shape, text, blocking }) => `${shape} (${blocking ? "blocking" : "advisory"}):\n${text}`);
  const defectClass = verdict.defectClass === undefined ? [] : [`${DEFECT_CLASS_HEADING} ${verdict.defectClass}`];
  return [...sections, ...defectClass].join(FINDINGS_SEPARATOR);
}

function panelFixFirst(head: string, verdict: PanelVerdict): Verdict {
  return { kind: "FIX_FIRST", headSha: head, text: panelFindingsText(verdict), ...(verdict.closer !== undefined && { closer: verdict.closer }) };
}

const MemberVerdict = z.looseObject({ kind: z.literal("verdict"), reviewer: z.object({ agentId: z.string(), sessionId: z.string() }), locator: z.unknown() });

/** The members that gave a verdict, for TP-1927's record of who reviewed the head. */
export function panelMerge(verdict: PanelVerdict, results: readonly { shape: MemberResult["shape"]; result: object }[]): PanelMerge {
  const members = results.flatMap(({ shape, result }) => {
    const read = MemberVerdict.safeParse(result);
    return read.success ? [{ shape, ...read.data.reviewer, locator: read.data.locator }] : [];
  });
  return { satisfiesG10: verdict.satisfiesG10, degraded: verdict.degraded, members };
}

/**
 * Every member but correctness is started before any verdict is awaited, so they review side by side; correctness keeps its
 * late read, correction turn and usage-limit hold. The recorded aggregate decides, and a panel that is not unanimous never merges.
 */
export async function panelReview(ctx: WorkflowContext, intent: PanelIntent, base: MemberBase, awaiting: AwaitVerdictInput, dispatchedReviewer: AgentIdentity, account: string): Promise<Verdict> {
  const target: ReviewTarget = { repo: base.repo, pr: base.pr, head: base.head };
  const members = await dispatchMembers(ctx, intent, base);
  const taken = await takeAwaited(ctx, target, awaiting, dispatchedReviewer, account);
  if ("held" in taken) return taken.held;
  const results = [{ shape: "correctness" as const, result: memberResultOf(taken.awaited) }, ...(await awaitMembers(ctx, target, members))];
  const verdict = await panelVerdict(ctx, target, intent.plan, results, base.fixProof);
  if (verdict.outcome === "FIX_FIRST") return panelFixFirst(target.head, verdict);
  if (verdict.outcome !== "MERGE" && taken.awaited.kind === "verdict") return { kind: "none", cause: verdict.outcome === "timeout" ? "timeout" : "no-verdict", reason: "a blocking panel member gave no verdict" };
  const decided = await verdictOf(ctx, target, awaiting, dispatchedReviewer, taken.awaited);
  return decided.kind === "MERGE" && verdict.outcome === "MERGE" ? { ...decided, panel: panelMerge(verdict, results) } : decided;
}
