/**
 * `rounds.answer-rec` (TP-4044): the nudge's one tap, or the owner's "rec" reply, answers every question of a round
 * with its recommendation. It never writes feedback.json itself: it builds the answers and hands them to
 * `rounds.submit`'s own pipeline, so the decision log, the listeners and the seat notice hear it as they hear a phone
 * answer. The feedback's `general` says `answered-by-rec`, as the strict feedback@1 schema has no field for it.
 *
 * Each answer is tagged seen: it is the recommendation, whether the nudge stated it or, in an after-answer round, the
 * owner accepted it unseen. An after-answer round records each in `revealed.json` first, as `rounds.reveal` would, since `rounds.submit` takes a seen tag only on a revealed question.
 * The request names the round.json sha256 the nudge was built from, and a changed round is refused.
 */
import path from "node:path";
import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { ownerWriteCommand } from "./owner-guard.js";
import { ANSWERED_BY_REC, recAnswers } from "./round-nudge.js";
import { recordReveal } from "./round-reveal.js";
import { readManifest, roundDirExists, statusOf, type RoundsSource } from "./rounds.js";
import { submitResult, type SubmitPipeline, type SubmitResult } from "./rounds-submit.js";

const answerRecArgs = z.strictObject({
  id: z.string().min(1).max(64),
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

type AnswerRecArgs = z.infer<typeof answerRecArgs>;

/** `answered` counts the questions the recommendations answered; `result` is `rounds.submit`'s own. */
interface RecAnswer {
  answered: number;
  result: SubmitResult;
}

const refuse = (message: string): never => {
  throw failure(message, EXIT.DATAERR);
};

/** The one answer-rec path: the RPC command and the `rounds answer-rec` verb (TP-4054) both run it. */
export async function answerWithRecommendations(dir: string, submit: SubmitPipeline, { id, manifestSha256 }: AnswerRecArgs, now = new Date()): Promise<RecAnswer> {
  if (!(await roundDirExists(dir, id))) throw failure(`No round named "${id}"`, EXIT.NOINPUT);
  const roundDir = path.join(dir, id);
  const status = await statusOf(roundDir);
  if (status !== "open") refuse(`refused: ${status}; only an open round takes the one-tap answer`);
  const { parsed } = await readManifest(roundDir);
  if (!parsed.ok) return refuse(`round.json is not a valid round: ${parsed.reason}`);
  if (parsed.sha256 !== manifestSha256) refuse("round.json has changed since it was shown; reload the round");
  const built = recAnswers(parsed.manifest);
  if ("reason" in built) return refuse(`no one-tap answer: ${built.reason}`);
  if (parsed.manifest.recommendations === "after-answer") {
    for (const { questionId } of built.answers) await recordReveal(roundDir, questionId, now);
  }
  const result = await submit({ id, manifestSha256, answers: built.answers, general: ANSWERED_BY_REC });
  return { answered: built.answers.length, result };
}

export function roundsAnswerRecCommands({ dir }: RoundsSource, submit: SubmitPipeline) {
  return {
    "rounds.answer-rec": ownerWriteCommand({
      name: "rounds.answer-rec",
      description: "Answer every question of one round with its recommendation, through rounds.submit, marked answered-by-rec; refused when a question has none, is a Ship or records a plan approval",
      args: answerRecArgs,
      result: submitResult,
      ownerWrite: true,
      run: async (args) => (await answerWithRecommendations(dir, submit, args)).result,
    }),
  };
}
