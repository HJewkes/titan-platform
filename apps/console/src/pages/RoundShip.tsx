import { useState, type ReactNode } from "react";
import { Alert, Button, ButtonText, Card, CardContent, HStack, Input, Typography, VStack } from "@titan-design/react-ui";
import type { RoundDetail } from "../../server/rounds.js";
import type { Question } from "../../server/round-schema.js";
import { useSubmit, type SubmitState } from "../data/submit.js";
import { QuestionFrames } from "./QuestionFrames.js";
import { inOrder, submittedAnswers } from "./RoundAnswers.js";
import { RoundGeneral, SentComment, SentGeneral } from "./RoundComment.js";
import { QuestionFacts } from "./RoundQuestion.js";
import { useRoundAnswers, type RoundAnswers } from "./RoundSections.js";
import { sendBackBlocker, shipBlockers } from "../../server/ship-blockers.js";
import { ShipLineageLine } from "./ShipLineage.js";
import { Montages } from "./ShipMontages.js";
import { ShipPriorFeedback } from "./ShipPriorFeedback.js";
import { ShipPrsRound } from "./ShipPrs.js";
import { ShipNotices, SideQuestion, sideMarks } from "./ShipSide.js";

type ValidRound = Extract<RoundDetail, { valid: true }>;
type PickOne = Extract<Question, { kind: "pick-one" }>;
type MergeQuestion = PickOne & { merge: NonNullable<PickOne["merge"]> };
type GateAnswer = ValidRound["answer"];

const isMergeQuestion = (question: Question): question is MergeQuestion => question.kind === "pick-one" && question.merge !== undefined;
const sha7 = (sha: string): string => sha.slice(0, 7);

/**
 * A merge gate: each changed image as before | after | diff, the round's other questions in order, then the
 * Ship or Send back pick bound to the PR head. The pick comes last because it sends every answer above it.
 */
export function ShipRound({ round }: { round: ValidRound }): ReactNode {
  const merges = round.manifest.questions.filter(isMergeQuestion);
  return merges.length > 1 ? <ShipPrsRound round={round} merges={merges} /> : <OnePrRound round={round} />;
}

/** A round with one Ship question; several are one per PR (TP-3329). */
function OnePrRound({ round }: { round: ValidRound }): ReactNode {
  const question = round.manifest.questions.find(isMergeQuestion);
  const sideQuestions = round.manifest.questions.filter((each) => each !== question);
  const submitting = useSubmit();
  const locked = round.status === "sent" || submitting.state.status === "sending" || submitting.state.status === "sent";
  // Locked, the side questions are not handed over, so no digit key can change an answer already sent.
  const side = useRoundAnswers(locked ? [] : sideQuestions);
  if (question === undefined) return null;
  return (
    <VStack gap={4}>
      <ShipHeading round={round} question={question} />
      <Montages round={round} merge={question.merge} />
      {round.manifest.questions.map((each, index) =>
        each === question ? null : <SideQuestion key={each.id} round={round} question={each} position={index + 1} side={side} locked={locked} />,
      )}
      <ShipPriorFeedback items={round.priorFeedback ?? []} addressed={side.addressed} onToggle={side.toggleAddressed} />
      <ShipAnswer round={round} question={question} sideQuestions={sideQuestions} side={side} submitting={submitting} />
    </VStack>
  );
}

function ShipHeading({ round, question }: { round: ValidRound; question: MergeQuestion }): ReactNode {
  const section = round.manifest.sections.find((candidate) => candidate.questionIds.includes(question.id));
  return (
    <Card variant="subtle">
      <CardContent>
        <VStack gap={2}>
          <QuestionFrames question={question} />
          <Typography variant="subtitle1">{question.prompt}</Typography>
          {section?.changed ? <Typography variant="caption">{`Changed: ${section.changed}`}</Typography> : null}
          <QuestionFacts question={question} />
          <ShipLineageLine lineage={round.lineage} />
          {round.recommendationsWithheld ? <Typography variant="caption" color="secondary">The recommendation shows once the round is answered.</Typography> : null}
        </VStack>
      </CardContent>
    </Card>
  );
}

interface ShipAnswerProps {
  round: ValidRound;
  question: MergeQuestion;
  sideQuestions: readonly Question[];
  side: RoundAnswers;
  submitting: ReturnType<typeof useSubmit>;
}

/** The two presses' `rounds.submit` args, and why each is off: Ship by its blockers, Send back until the fixer would get a note. */
function shipDraft({ round, question, sideQuestions, side }: Omit<ShipAnswerProps, "submitting">, note: string) {
  const sendBack = question.options.find((option) => !question.merge.ship.includes(option));
  const comment = note.trim();
  const sent = { id: round.id, manifestSha256: round.manifestSha256, general: side.general.trim() };
  const sideAnswers = submittedAnswers(sideQuestions, side.answers, side.comments, side.optionNotes);
  const { addressed, followUps } = sideMarks(side);
  const shipArgs = { ...sent, ...addressed, ...followUps, headSha: question.merge.headSha, answers: inOrder(round.manifest, [...sideAnswers, { questionId: question.id, pick: question.merge.ship[0] }]) };
  const backArgs = { ...sent, ...followUps, answers: inOrder(round.manifest, [...sideAnswers, { questionId: question.id, pick: sendBack, ...(comment ? { comment } : {}) }]) };
  return {
    shipArgs,
    backArgs,
    canSendBack: sendBack !== undefined,
    blockers: shipBlockers(round.manifest, round.priorFeedback ?? [], { answers: sideAnswers, general: sent.general, addressed: side.addressed, followUps: side.followUps }),
    noNote: sendBackBlocker(backArgs, question.id),
  };
}

/** Unanswered questions block neither press (decisions 166 and 513); Send back waits only for a note. */
function ShipAnswer(props: ShipAnswerProps): ReactNode {
  const { round, question, side, submitting } = props;
  const { available, state, submit } = submitting;
  const [note, setNote] = useState("");
  if (round.status === "sent" || state.status === "sent") return <ShipOutcome round={round} question={question} state={state} />;
  const draft = shipDraft(props, note);
  const disabled = !available || state.status === "sending";
  return (
    <Card variant="outline">
      <CardContent>
        <VStack gap={3}>
          <RoundGeneral value={side.general} onChange={side.setGeneral} />
          <Input multiline numberOfLines={3} label="Note for Send back (optional)" accessibilityLabel="Note for Send back" value={note} onChangeText={setNote} />
          <HStack gap={3} wrap>
            <Button color="success" isDisabled={disabled || draft.blockers.length > 0} onPress={() => void submit(draft.shipArgs)}><ButtonText>Ship</ButtonText></Button>
            <Button variant="outline" color="warning" isDisabled={disabled || draft.noNote !== undefined || !draft.canSendBack} onPress={() => void submit(draft.backArgs)}><ButtonText>Send back</ButtonText></Button>
          </HStack>
          <ShipNotices blockers={draft.blockers} noNote={draft.noNote} available={available} state={state} />
        </VStack>
      </CardContent>
    </Card>
  );
}

/** A resolved outcome names the answer it applied; one that does not still says the gate is settled, without claiming a merge. */
function resolvedLine(answer: NonNullable<GateAnswer>, headSha: string): string {
  if (answer.choice === "merge") return `Merging at ${sha7(headSha)}`;
  return answer.choice === "send-back" ? "Sent back: the implementer gets your note" : "Answer applied";
}

/** The ledger's gate-answer lines; with no outcome yet the factory has not picked the answer up. */
function outcomeLine(answer: GateAnswer, headSha: string): { status: "info" | "success" | "warning"; message: string } {
  if (answer === undefined) return { status: "info", message: "Waiting for the factory" };
  const reason = answer.reason ?? "no reason given";
  const lines = {
    resolved: { status: "success", message: resolvedLine(answer, headSha) },
    already: { status: "info", message: "Already answered" },
    moved: { status: "warning", message: `Head moved to ${sha7(answer.currentHead ?? "unknown")}; a new round follows` },
    gone: { status: "warning", message: `Gate closed (${reason})` },
    refused: { status: "warning", message: `Not applied: ${reason}` },
    off: { status: "warning", message: "Not applied: gate answers are off in the factory" },
  } as const;
  return lines[answer.status];
}

function ShipOutcome({ round, question, state }: { round: ValidRound; question: MergeQuestion; state: SubmitState }): ReactNode {
  return (
    <VStack gap={3}>
      <AnswerOutcome answer={round.answer} headSha={question.merge.headSha} state={state} />
      <SentComment questionId={question.id} text={round.notes?.comments[question.id]} />
      <SentGeneral text={round.notes?.general} />
    </VStack>
  );
}

function AnswerOutcome({ answer, headSha, state }: { answer: GateAnswer; headSha: string; state: SubmitState }): ReactNode {
  const already = state.status === "sent" && state.already;
  const { status, message } = already ? { status: "info" as const, message: "Already answered" } : outcomeLine(answer, headSha);
  return <Alert status={status} message={message} />;
}
