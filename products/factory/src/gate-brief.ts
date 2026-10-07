import type { GateBrief, GateQuestion } from "@titan-design/hitl";
import { z } from "zod";
import type { Verdict } from "./shepherd/phases.js";
import type { FailingCheck } from "./workflows/land-ci.js";

const MAX_SUMMARY = 280;

export interface DecisionOption<Id extends string> {
  id: Id;
  label: string;
  recommended?: boolean;
}

export interface DecisionGate<Id extends string, Shape extends z.ZodRawShape> {
  /** Validates the answer: `decision` is one of the option ids, plus whatever `shape` pins. */
  schema: z.ZodObject<{ decision: z.ZodEnum<{ [K in Id]: K }> } & Shape>;
  questions: GateQuestion[];
}

/** One option list builds the question the owner reads and the enum the answer is checked against, so the two cannot drift. */
export function decisionGate<const Id extends string, Shape extends z.ZodRawShape = Record<never, never>>(spec: {
  question: string;
  options: readonly [DecisionOption<Id>, ...DecisionOption<Id>[]];
  shape?: Shape;
}): DecisionGate<Id, Shape> {
  const ids = spec.options.map((option) => option.id) as [Id, ...Id[]];
  const schema = z.object({ decision: z.enum(ids), ...spec.shape }) as unknown as DecisionGate<Id, Shape>["schema"];
  const options = spec.options.map(({ id, label, recommended }) => ({ id, label, ...(recommended && { recommended: true as const }) }));
  return { schema, questions: [{ id: "decision", question: spec.question, options }] };
}

/** Collapses whitespace and control characters, then cuts at `max` with an ellipsis, so free text fits a one-line field. */
export function oneLine(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what a one-line field refuses
  const flat = text.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The fixed words are never cut; only `detail` shrinks to leave the summary within the field's bound. */
function summarize(lead: string, detail: string, tail = ""): string {
  const room = MAX_SUMMARY - lead.length - tail.length - 2;
  const middle = detail === "" || room < 8 ? "" : ` ${oneLine(detail, room)}`;
  return `${lead}${middle}${tail === "" ? "" : ` ${tail}`}`;
}

export const prEvidence = (repo: string, pr: number): string => `https://github.com/${repo}/pull/${pr}`;

/** The first failing check that names a link; the PR itself when none does. */
export function ciEvidence(failing: readonly FailingCheck[], fallback: string): string {
  return failing.find((check) => check.url.startsWith("https://"))?.url ?? fallback;
}

/** Main's CI run for the merge commit is not read by any step, so the owner gets the command that lists it. */
export const mainEvidence = (repo: string, mergeSha: string): string => `$ gh run list -R ${repo} -c ${mergeSha}`;

/** A reviewer's MERGE vouches for the head it names and no other. */
export const verdictIsMergeAt = (verdict: Verdict | undefined, headSha: string): boolean => verdict?.kind === "MERGE" && verdict.headSha === headSha;

export interface PrHead {
  repo: string;
  pr: number;
  headSha: string;
}

const where = ({ repo, pr, headSha }: PrHead): string => `${repo}#${pr} at ${headSha}`;

export function approveMergeDecision(target: PrHead & { reason: string; reviewedMerge: boolean }) {
  const { schema, questions } = decisionGate({
    question: `Land ${target.headSha}?`,
    options: [
      { id: "merge", label: "Merge at this head", recommended: target.reviewedMerge },
      { id: "abandon", label: "Abandon the PR" },
    ],
    shape: { headSha: z.literal(target.headSha) },
  });
  const verdict = target.reviewedMerge ? "Reviewer said MERGE at this head; recommend merge." : "No reviewer MERGE at this head; no recommendation.";
  const summary = summarize(`Merge ${where(target)}? CI green.`, target.reason, verdict);
  return { schema, brief: brief(summary, prEvidence(target.repo, target.pr), questions) };
}

export function conflictDecision(target: PrHead & { reason: string }) {
  const { schema, questions } = decisionGate({
    question: `Land the next resolved head of PR #${target.pr}?`,
    options: [
      { id: "merge", label: "Land the next resolved head" },
      { id: "abandon", label: "Abandon the PR" },
    ],
    shape: { headSha: z.literal(target.headSha) },
  });
  const summary = summarize(`Conflict on ${where(target)} survived a fixer.`, target.reason, "Merge waits for a resolved head; abandon stops.");
  return { schema, brief: brief(summary, prEvidence(target.repo, target.pr), questions) };
}

export function ciFailedDecision(target: PrHead & { failing: readonly FailingCheck[] }) {
  const { schema, questions } = decisionGate({
    question: `What now for the red CI at ${target.headSha}?`,
    options: [
      { id: "rerun", label: "Rerun the failed checks" },
      { id: "abandon", label: "Abandon the PR" },
      { id: "await-fix", label: "Wait for a fix" },
    ],
    shape: { headSha: z.literal(target.headSha) },
  });
  const names = target.failing.map((check) => check.name).join(", ");
  const summary = summarize(`CI failed on ${where(target)}.`, names === "" ? "No failing check is named." : `Failing: ${names}.`);
  return { schema, brief: brief(summary, ciEvidence(target.failing, prEvidence(target.repo, target.pr)), questions) };
}

export function stuckBehindDecision(target: { repo: string; pr: number; headSha: string; why: string }) {
  const { schema, questions } = decisionGate({
    question: `Retry the update of PR #${target.pr}?`,
    options: [
      { id: "retry", label: "Retry the update" },
      { id: "abandon", label: "Abandon the PR" },
    ],
  });
  const summary = summarize(`${where(target)} is stuck behind its base.`, `${target.why}.`);
  return { schema, brief: brief(summary, prEvidence(target.repo, target.pr), questions) };
}

export function sentBackDecision(target: PrHead & { situation: string }) {
  const { schema, questions } = decisionGate({
    question: `Wait for a new head of PR #${target.pr}?`,
    options: [
      { id: "await-new-head", label: "Wait for a new head", recommended: true },
      { id: "abandon", label: "Abandon the PR" },
    ],
  });
  const summary = summarize(`${where(target)} needs a decision.`, target.situation, "Recommend waiting for a new head.");
  return { schema, brief: brief(summary, prEvidence(target.repo, target.pr), questions) };
}

export function frozenDecision(target: { repo: string; mergeSha: string; situation: string }) {
  const { schema, questions } = decisionGate({
    question: `Keep ${target.repo} frozen?`,
    options: [
      { id: "stay-frozen", label: "Stay frozen", recommended: true },
      { id: "unfreeze", label: "Unfreeze now" },
    ],
    shape: { mergeSha: z.string() },
  });
  const summary = summarize(`${target.repo} is frozen after main at ${target.mergeSha}.`, target.situation, "Recommend staying frozen.");
  return { schema, brief: brief(summary, mainEvidence(target.repo, target.mergeSha), questions) };
}

/** A gate whose only answer is an acknowledgement carries no question menu. */
export function acknowledgeBrief(target: { repo: string; mergeSha: string; headline: string; detail: string }): GateBrief {
  return brief(summarize(`${target.headline} at ${target.mergeSha}.`, target.detail, "Acknowledge."), mainEvidence(target.repo, target.mergeSha));
}

function brief(summary: string, evidenceRef: string, questions?: GateQuestion[]): GateBrief {
  return { summary, evidenceRef, ...(questions && { questions }) };
}
