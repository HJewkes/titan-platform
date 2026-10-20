import { createHash } from "node:crypto";
import type { WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import type { PendingGate } from "../host.js";
import { authorityGate, seatPolicyHead } from "./head-moved.js";
import { gateHead } from "./stale-gates.js";

/** A submit older than this resolves nothing; the owner's click and the dialog it leads to are seconds apart. */
export const ROUND_SUBMIT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** How long a Ship stands as the owner's merge approval before the gate it answers opens (TP-1842 Q2 default, item 88). */
export const SHIP_APPROVAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A Ship stamped further ahead of the reader's clock than this is not believed: a future time would never go stale. */
const SUBMIT_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * What round.json must carry per pick-one question that decides a merge. The review harness (TP-1844) writes it:
 * `ship` lists the options consistent with merging `repo#pr` at `headSha`, never the revision option.
 */
const MergeBinding = z.object({
  repo: z.string(),
  pr: z.number().int(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  ship: z.array(z.string()),
});

const RoundManifest = z.object({
  unit: z.string(),
  round: z.number().int(),
  questions: z.array(z.object({ id: z.string(), merge: MergeBinding.optional() })),
});

/** The parts of feedback.json this decision reads; other keys are dropped. */
export const RoundFeedbackSchema = z.object({
  unit: z.string(),
  round: z.number().int(),
  manifestSha256: z.string(),
  submittedAt: z.string(),
  answers: z.array(z.object({ questionId: z.string(), pick: z.string().optional(), revisionRequested: z.boolean().optional() })),
});

export type RoundFeedback = z.infer<typeof RoundFeedbackSchema>;

type RoundMergeOutcome =
  | { kind: "resolve"; runId: string; stepId: string; payload: { decision: "merge"; headSha: string } }
  | { kind: "pending"; reason: string }
  | { kind: "no-gate" };

type RoundMergeDecision = { repo: string; pr: number; headSha: string } & RoundMergeOutcome;

interface RoundMergeResult {
  /** Why the whole round answers nothing; undefined when it was read. */
  refused: string | undefined;
  decisions: RoundMergeDecision[];
}

interface Bound {
  repo: string;
  pr: number;
  headSha: string;
}

const refuse = (reason: string): RoundMergeResult => ({ refused: reason, decisions: [] });

function parseRound(roundBytes: string | Uint8Array): z.infer<typeof RoundManifest> | undefined {
  try {
    const parsed = RoundManifest.safeParse(JSON.parse(Buffer.from(roundBytes).toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function refusal(round: z.infer<typeof RoundManifest>, roundBytes: string | Uint8Array, feedback: RoundFeedback, now: Date, maxAgeMs: number): string | undefined {
  if (createHash("sha256").update(roundBytes).digest("hex") !== feedback.manifestSha256) return "the feedback was not written against this round.json (manifest hash differs)";
  if (feedback.unit !== round.unit || feedback.round !== round.round) return `the feedback is for ${feedback.unit} r${feedback.round}, the round is ${round.unit} r${round.round}`;
  const age = now.getTime() - Date.parse(feedback.submittedAt);
  return Number.isNaN(age) || age > maxAgeMs ? "the submit is stale or has no valid time" : undefined;
}

/** One entry per PR, at the head its first question names; a question naming another head blocks the PR in `blockingQuestion`. */
function bindings(round: z.infer<typeof RoundManifest>): Bound[] {
  const byPr = new Map<string, Bound>();
  for (const { merge } of round.questions) {
    if (merge && !byPr.has(`${merge.repo}#${merge.pr}`)) byPr.set(`${merge.repo}#${merge.pr}`, { repo: merge.repo, pr: merge.pr, headSha: merge.headSha });
  }
  return [...byPr.values()];
}

/** Each `repo#pr` a round's questions bind, whatever the head; none for bytes that do not read as a round. */
export function boundPrs(roundBytes: string | Uint8Array): string[] {
  const round = parseRound(roundBytes);
  return round ? bindings(round).map((bound) => `${bound.repo}#${bound.pr}`) : [];
}

/** The first question that keeps the PR from shipping: unanswered, a revision request, or a pick outside its ship list. */
function blockingQuestion(round: z.infer<typeof RoundManifest>, bound: Bound, feedback: RoundFeedback): string | undefined {
  const questions = round.questions.filter((q) => q.merge && `${q.merge.repo}#${q.merge.pr}` === `${bound.repo}#${bound.pr}`);
  return questions.find((q) => {
    const answer = feedback.answers.find((a) => a.questionId === q.id);
    return !answer || answer.revisionRequested === true || answer.pick === undefined || !q.merge!.ship.includes(answer.pick) || q.merge!.headSha !== bound.headSha;
  })?.id;
}

const GATE_TARGET = /^Merge PR #(\d+) in (\S+) at head /;
const POLICY_IN_PROMPT = /\bPolicy ([\w-]+)\/([\w-]+)/;

function targets(gate: PendingGate, bound: Bound): boolean {
  const match = GATE_TARGET.exec(gate.gate.prompt);
  return gate.stepId === "approve-merge" && match?.[1] === String(bound.pr) && match[2] === bound.repo;
}

/** Only a plain policy gate: a seat owner-gate or authority MRG-AU, as the run itself recorded it. */
function answerable(gate: PendingGate, run: WorkflowRun | undefined): boolean {
  if (!run || run.workflowName !== "shepherd-pr") return false;
  const { prompt } = gate.gate;
  return seatPolicyHead(run, prompt) !== undefined || authorityGate(run, prompt) !== undefined;
}

function kindOf(gate: PendingGate): string {
  const policy = POLICY_IN_PROMPT.exec(gate.gate.prompt);
  return policy ? `${policy[1]}/${policy[2]}` : "unrecognised";
}

function decide(round: z.infer<typeof RoundManifest>, bound: Bound, feedback: RoundFeedback, gates: PendingGate[], runs: Map<string, WorkflowRun>): RoundMergeOutcome {
  const mine = gates.filter((gate) => targets(gate, bound));
  if (mine.length === 0) return { kind: "no-gate" };
  const plain = mine.filter((gate) => answerable(gate, runs.get(gate.runId)));
  if (plain.length === 0) return { kind: "pending", reason: `the gate is a ${kindOf(mine[0]!)} gate; the round showed the render, not that decision` };
  const blocked = blockingQuestion(round, bound, feedback);
  if (blocked) return { kind: "pending", reason: `question ${blocked} is not answered with a ship option at head ${bound.headSha}` };
  const gate = plain.find((candidate) => gateHead(candidate.gate.prompt) === bound.headSha) ?? plain[0]!;
  const asked = gateHead(gate.gate.prompt);
  if (asked !== bound.headSha) return { kind: "pending", reason: `PR moved from ${bound.headSha} to ${asked ?? "an unread head"} after the round was built` };
  return { kind: "resolve", runId: gate.runId, stepId: gate.stepId, payload: { decision: "merge", headSha: bound.headSha } };
}

/**
 * Which pending approve-merge gates a submitted review round answers. The gate's head is Shepherd's own read (the gate prompt),
 * never the round's; a gate resolves only at the bound head exactly. Pure: the caller supplies the gates, runs and clock.
 */
export function roundMergeDecisions(
  roundBytes: string | Uint8Array,
  feedback: RoundFeedback,
  pendingGates: PendingGate[],
  runs: WorkflowRun[],
  now: Date,
  maxAgeMs: number = ROUND_SUBMIT_MAX_AGE_MS,
): RoundMergeResult {
  const round = parseRound(roundBytes);
  if (!round) return refuse("round.json does not read as a round");
  const refused = refusal(round, roundBytes, feedback, now, maxAgeMs);
  if (refused) return refuse(refused);
  const byRun = new Map(runs.map((run) => [run.id, run]));
  const decisions = bindings(round).map((bound) => ({ repo: bound.repo, pr: bound.pr, headSha: bound.headSha, ...decide(round, bound, feedback, pendingGates, byRun) }));
  return { refused: undefined, decisions };
}

type ShipAtHead =
  | { shipped: true; unit: string; round: number; questionIds: string[]; submittedAt: string }
  | { shipped: false; reason: string };

const notShipped = (reason: string): ShipAtHead => ({ shipped: false, reason });

/**
 * Whether a submitted round is the owner's merge approval for one PR at one head (decisions item 97): every question bound to the
 * PR is picked from its ship list at exactly `target.headSha`. A Ship at any other head never counts (item 95 rule 1). Unlike
 * `roundMergeDecisions` this needs no open gate, so it can answer before the gate opens. Pure: the caller supplies the clock.
 */
export function shipAtHead(
  roundBytes: string | Uint8Array,
  feedback: RoundFeedback,
  target: { repo: string; pr: number; headSha: string },
  now: Date,
  maxAgeMs: number = SHIP_APPROVAL_MAX_AGE_MS,
): ShipAtHead {
  const round = parseRound(roundBytes);
  if (!round) return notShipped("round.json does not read as a round");
  const refused = refusal(round, roundBytes, feedback, now, maxAgeMs);
  if (refused) return notShipped(refused);
  if (Date.parse(feedback.submittedAt) - now.getTime() > SUBMIT_CLOCK_SKEW_MS) return notShipped("the submit is stamped in the future");
  const bound = bindings(round).find((candidate) => candidate.repo === target.repo && candidate.pr === target.pr);
  if (!bound) return notShipped(`no question binds ${target.repo}#${target.pr}`);
  if (bound.headSha !== target.headSha) return notShipped(`the round binds ${target.repo}#${target.pr} at ${bound.headSha}, the PR is at ${target.headSha}`);
  const blocked = blockingQuestion(round, bound, feedback);
  if (blocked) return notShipped(`question ${blocked} is not answered with a ship option at head ${bound.headSha}`);
  const questionIds = round.questions.filter((q) => q.merge?.repo === bound.repo && q.merge.pr === bound.pr).map((q) => q.id);
  return { shipped: true, unit: round.unit, round: round.round, questionIds, submittedAt: feedback.submittedAt };
}
