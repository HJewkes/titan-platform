import type { GateBrief, GateQuestion } from "@titan-design/hitl";
import type { OwnerBrief } from "@titan-design/review-panel";
import { z } from "zod";
import type { Verdict } from "./shepherd/phases.js";
import type { FailingCheck } from "./workflows/land-ci.js";

const MAX_SUMMARY = 280;
const MAX_EVIDENCE_REF = 500;
const MAX_QUESTION = 500;

interface DecisionOption<Id extends string> {
  id: Id;
  label: string;
  recommended?: boolean;
}

interface DecisionGate<Id extends string, Shape extends z.ZodRawShape> {
  /** Validates the answer: `decision` is one of the option ids, plus whatever `shape` pins. */
  schema: z.ZodObject<{ decision: z.ZodEnum<{ [K in Id]: K }> } & Shape>;
  questions: GateQuestion[];
}

/** One option list builds the question the owner reads and the enum the answer is checked against, so the two cannot drift. */
function decisionGate<const Id extends string, Shape extends z.ZodRawShape = Record<never, never>>(spec: {
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
  const room = MAX_SUMMARY - lead.length - tail.length - 3;
  const cut = detail === "" || room < 8 ? "" : oneLine(detail, room);
  const middle = cut === "" ? "" : ` ${/[.?!…]$/.test(cut) ? cut : `${cut}.`}`;
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

/** An owner brief belongs to the reviewed head, so a MERGE at another head lends it to no gate. */
export const ownerBriefAt = (verdict: Verdict | undefined, headSha: string): OwnerBrief | undefined =>
  verdict?.kind === "MERGE" && verdict.headSha === headSha ? verdict.ownerBrief : undefined;

export function ownerBriefLines(ownerBrief: OwnerBrief): string[] {
  const bullets = (items: readonly string[]) => items.map((item) => `- ${item}`);
  return [`What: ${ownerBrief.what}`, `Why: ${ownerBrief.why}`, "Pros:", ...bullets(ownerBrief.pros), "Cons:", ...bullets(ownerBrief.cons), `Door: ${ownerBrief.doorType}`];
}

interface PrHead {
  repo: string;
  pr: number;
  headSha: string;
}

const where = ({ repo, pr, headSha }: PrHead): string => `${repo}#${pr} at ${headSha}`;

const prFilesEvidence = (repo: string, pr: number): string => `${prEvidence(repo, pr)}/files`;

/** Each path is flattened to one line, so a path holding a newline cannot pose as a line of the prompt it is shown in. */
const shownSkillPaths = (skillPaths: readonly string[]): string => skillPaths.map((path) => oneLine(path, MAX_EVIDENCE_REF)).join(", ");

/** The owner reads a repo skill change in the diff itself. The link leads, so a long path list cut to fit a field never cuts it. */
export function skillChangeNote(repo: string, pr: number, skillPaths: readonly string[]): string {
  return `Review the repo skill diff: ${prFilesEvidence(repo, pr)}. Repo skill changes: ${shownSkillPaths(skillPaths)}.`;
}

interface ApproveMergeTarget extends PrHead {
  reason: string;
  reviewedMerge: boolean;
  carriedFrom?: string;
  ownerBrief?: OwnerBrief;
  skillPaths?: readonly string[];
  /** Offers `send-back`, whose answer must carry the owner's note; only `shepherd.consoleAnswers` turns it on. */
  sendBack?: boolean;
}

export const SEND_BACK = "send-back";

/**
 * The gate store checks a payload against the JSON schema alone, and its check reads `anyOf` in place of the top-level
 * properties. So each answer shape is spelled out there in full, and a send-back with no note fails at the store, before
 * any resolver (gateNotify's bare option, a coordinator) can settle the gate with it. The top level keeps `headSha.const`
 * for the readers that take the gate's head from it.
 */
function sendBackShapes(headSha: string): Record<string, unknown>[] {
  const shapes = [
    z.strictObject({ decision: z.enum(["merge", "abandon"]), headSha: z.literal(headSha) }),
    z.strictObject({ decision: z.literal(SEND_BACK), headSha: z.literal(headSha), note: z.string() }),
  ];
  return shapes.map((shape) => {
    const { $schema: _, ...json } = z.toJSONSchema(shape);
    return json;
  });
}

const sendBackNeedsNote = (answer: { decision: string; note?: unknown }, ctx: z.RefinementCtx): void => {
  if (answer.decision === SEND_BACK && (typeof answer.note !== "string" || answer.note.trim() === "")) ctx.addIssue({ code: "custom", path: ["note"], message: "a send-back carries the owner's note" });
};

/**
 * `carriedFrom` is the reviewed head whose MERGE stands at this tree-equal head, so the owner is not told the reviewer saw
 * this one. A skill change is never recommended: a reviewer's MERGE does not stand in for the owner reading that diff.
 */
export function approveMergeDecision(target: ApproveMergeTarget) {
  const skills = target.skillPaths ?? [];
  const asked = skills.length > 0 ? `Land ${target.headSha}? ${skillChangeNote(target.repo, target.pr, skills)}` : `Land ${target.headSha}?`;
  const sendBack = target.sendBack ? [{ id: SEND_BACK, label: "Send back to the implementer with your note" } as const] : [];
  const { schema, questions } = decisionGate({
    question: target.ownerBrief ? oneLine(`${asked} Reviewer's owner brief: ${ownerBriefLines(target.ownerBrief).join(" ")}`, MAX_QUESTION) : oneLine(asked, MAX_QUESTION),
    options: [
      { id: "merge", label: "Merge at this head", recommended: target.reviewedMerge && skills.length === 0 },
      { id: "abandon", label: "Abandon the PR" },
      ...sendBack,
    ],
    shape: { headSha: z.literal(target.headSha), ...(target.sendBack && { note: z.string().optional() }) },
  });
  const checked = target.sendBack ? schema.superRefine(sendBackNeedsNote).meta({ anyOf: sendBackShapes(target.headSha) }) : schema;
  return { schema: checked, brief: skills.length > 0 ? skillMergeBrief(target, skills, questions) : mergeBrief(target, questions) };
}

function mergeBrief(target: ApproveMergeTarget, questions: GateQuestion[]): GateBrief {
  const said = target.carriedFrom ? `Reviewer said MERGE at ${target.carriedFrom}, carried from a tree-equal head` : "Reviewer said MERGE at this head";
  const verdict = target.reviewedMerge ? `${said}; recommend merge.` : "No reviewer MERGE at this head; no recommendation.";
  return brief(summarize(`Merge ${where(target)}? CI green.`, target.reason, verdict), prEvidence(target.repo, target.pr), questions);
}

/**
 * The files URL rides in the fixed tail, so a long path list or reason can never cut it. The evidence link stays the
 * plain PR URL, the form the coordinator reads a PR gate's PR from.
 */
function skillMergeBrief(target: ApproveMergeTarget, skills: readonly string[], questions: GateQuestion[]): GateBrief {
  const files = prFilesEvidence(target.repo, target.pr);
  const summary = summarize(`Merge ${where(target)}? CI green.`, `Repo skill changes: ${shownSkillPaths(skills)}. ${target.reason}`, `Review the diff: ${files}; no recommendation.`);
  return brief(summary, prEvidence(target.repo, target.pr), questions);
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

/** A held-up read of the PR's own evidence: the owner answers once GitHub is healthy, with no menu. */
export function evidenceStalledBrief(target: PrHead & { situation: string }): GateBrief {
  return brief(summarize(`${where(target)} could not post its merge evidence.`, target.situation, "Answer once GitHub is healthy."), prEvidence(target.repo, target.pr));
}

function brief(summary: string, evidenceRef: string, questions?: GateQuestion[]): GateBrief {
  return { summary, evidenceRef: oneLine(evidenceRef, MAX_EVIDENCE_REF), ...(questions && { questions }) };
}
