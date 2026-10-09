import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { DeadlineTiming } from "../workflows/deadline.js";
import { step } from "../workflows/land.js";
import { HEAD } from "./await-verdict.js";
import type { AwaitVerdictInput, ReviewerAgent, ReviewerDispatch } from "./review.js";
import { Awaited, MalformedSchema, readMalformed } from "./review-schemas.js";
import { clearReviewWait, noteReviewWait, startedSession, whileBrokerBusy, whileBrokerDown, type BusyTiming, type PollTiming } from "./review-wait.js";
import { correctionPrompt } from "@titan-design/review-panel";

export const CORRECT_VERDICT_STEP = "sh-correct-verdict";

/** The await step's input, plus the malformed record its result carried. */
export const CorrectVerdictInputSchema = z.object({
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  head: z.string().regex(HEAD),
  reviewerAgentId: z.string().min(1),
  reviewerSessionId: z.string().min(1),
  dispatchedAt: z.number(),
  startedAt: z.number().optional(),
  malformed: MalformedSchema,
  ownerBrief: z.boolean().optional(),
});
export type CorrectVerdictInput = z.infer<typeof CorrectVerdictInputSchema>;

/** `asked` means the reviewer's session is running its correction turn since `startedAt`, epoch milliseconds. */
const Corrected = z.discriminatedUnion("kind", [z.looseObject({ kind: z.literal("asked"), startedAt: z.number() }), z.looseObject({ kind: z.literal("none"), reason: z.string() })]);
type NoCorrection = { kind: "none"; reason: string };
export type CorrectedResult = { kind: "asked"; startedAt: number } | NoCorrection;

export type CorrectTiming = PollTiming & BusyTiming & DeadlineTiming;

const none = (reason: string): NoCorrection => ({ kind: "none", reason });

/** A running session, or one written to after the malformed message, has already been asked: the resume appends to its transcript. */
const landed = (input: CorrectVerdictInput) => (row: ReviewerAgent) => row.presence !== "exited" || (row.lastWrittenAt !== undefined && row.lastWrittenAt > input.malformed.writtenAt);

/** Resumes the exited reviewer's own session once; a repeat whose resume already landed asks nothing, so the reviewer is never prompted twice. */
async function askOnce(dispatch: ReviewerDispatch, input: CorrectVerdictInput, timing: CorrectTiming, signal: AbortSignal, repeat: boolean): Promise<NoCorrection | undefined> {
  const rows = (await whileBrokerDown(timing, signal, () => dispatch.roster())).filter((row) => row.agentId === input.reviewerAgentId);
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) return none("the reviewer is not on the roster exactly once");
  if (repeat && landed(input)(row)) return undefined;
  // A live or detached agent cannot be resumed, and its next message would not answer the correction.
  if (row.presence !== "exited") return none("the reviewer had not exited, so it was not resumed");
  if (row.sessionId !== input.reviewerSessionId) return none("the reviewer's session changed, so it was not resumed");
  const { repo, pr, head, malformed, ownerBrief } = input;
  const prompt = correctionPrompt({ repo, pr, head, refusal: malformed.refusal, ...(ownerBrief && { ownerBrief }) });
  const note = (text: string) => noteReviewWait(repo, pr, `waiting for the broker to resume ${row.name} for its correction: ${text}`);
  try {
    await whileBrokerBusy(timing, signal, note, () => whileBrokerDown(timing, signal, () => dispatch.resume(row.name, prompt)));
  } finally {
    clearReviewWait(repo, pr);
  }
  return undefined;
}

/** The row's session id is set before any resume, so the wait is for a landed resume, not for a started session. */
async function resumeShown(dispatch: ReviewerDispatch, input: CorrectVerdictInput, timing: CorrectTiming, signal: AbortSignal): Promise<NoCorrection | undefined> {
  const holds = (row: ReviewerAgent) => row.agentId === input.reviewerAgentId && landed(input)(row);
  const { agent } = await startedSession(() => dispatch.roster(), holds, timing, signal);
  if (!agent) return none("the resumed reviewer did not show on the roster in time");
  if (agent.sessionId !== input.reviewerSessionId) return none("the resumed reviewer is in another session");
  return undefined;
}

/** The body of the sh-correct-verdict step: one correction turn in the same session, or `none` so a fresh reviewer follows. */
export async function correctVerdict(dispatch: ReviewerDispatch, input: CorrectVerdictInput, timing: CorrectTiming, signal: AbortSignal, repeat: boolean): Promise<CorrectedResult> {
  const refused = (await askOnce(dispatch, input, timing, signal, repeat)) ?? (await resumeShown(dispatch, input, timing, signal));
  return refused ?? { kind: "asked", startedAt: timing.now() };
}

type AwaitedOutput = z.infer<typeof Awaited>;

/**
 * A malformed final message gets one correction turn in the reviewer's own session, read by `replyStep` from the message written
 * after it. Only the first await's result reaches here, never the reply's, so a reviewer is corrected at most once per head.
 */
export async function correctOnce(ctx: WorkflowContext, awaiting: AwaitVerdictInput, awaited: AwaitedOutput, options: { ownerBrief: boolean; replyStep: string }): Promise<AwaitedOutput> {
  const malformed = readMalformed(awaited);
  if (!malformed) return awaited;
  const asked = await step(ctx, `${CORRECT_VERDICT_STEP}:${awaiting.head}`, { ...awaiting, malformed, ...(options.ownerBrief && { ownerBrief: true }) }, Corrected);
  if (asked.kind !== "asked") return asked;
  const reply = await step(ctx, options.replyStep, { ...awaiting, dispatchedAt: malformed.writtenAt, startedAt: asked.startedAt }, Awaited);
  if (reply.kind === "verdict") return reply;
  const again = readMalformed(reply);
  return { kind: "none", reason: again ? `the reviewer's verdict did not parse after one correction (${again.refusal})` : "the reviewer wrote no verdict after its correction" };
}
