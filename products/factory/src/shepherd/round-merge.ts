import { createHash } from "node:crypto";
import type { WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import type { PendingGate } from "../host.js";
import { authorityGate, seatPolicyHead } from "./head-moved.js";
import { gateHead } from "./stale-gates.js";

/** A submit older than this resolves nothing; the owner's click and the dialog it leads to are seconds apart. */
export const ROUND_SUBMIT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

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

/** The parts of feedback.json this decision reads. */
export interface RoundFeedback {
  unit: string;
  round: number;
  manifestSha256: string;
  submittedAt: string;
  answers: { questionId: string; pick?: string; revisionRequested?: boolean }[];
}

export type RoundMergeOutcome =
  | { kind: "resolve"; runId: string; stepId: string; payload: { decision: "merge"; headSha: string } }
  | { kind: "pending"; reason: string }
  | { kind: "no-gate" };

export type RoundMergeDecision = { repo: string; pr: number; headSha: string } & RoundMergeOutcome;

export interface RoundMergeResult {
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
