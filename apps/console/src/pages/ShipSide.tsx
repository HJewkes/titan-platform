import { useState, type ReactNode } from "react";
import { Alert, Typography, VStack } from "@titan-design/react-ui";
import type { RoundDetail } from "../../server/rounds.js";
import type { Question } from "../../server/round-schema.js";
import type { SubmitState } from "../data/submit.js";
import { submittedAnswers } from "./RoundAnswers.js";
import { RoundComment } from "./RoundComment.js";
import { RoundQuestion, chooseIn, type QuestionAnswer } from "./RoundQuestion.js";
import { ShipBlockedReason } from "./ShipPriorFeedback.js";
import { SentFollowUp, ShipStake } from "./ShipStake.js";

type ValidRound = Extract<RoundDetail, { valid: true }>;

/** The Addressed ticks and follow-up marks as `rounds.submit` args, each left out when empty. */
export function sideMarks(side: SideAnswers) {
  return {
    addressed: side.addressed.length > 0 ? { addressed: side.addressed } : {},
    followUps: side.followUps.length > 0 ? { followUps: side.followUps } : {},
  };
}

export function ShipNotices({ blockers, missing, available, state }: { blockers: string[]; missing: Question[]; available: boolean; state: SubmitState }): ReactNode {
  return (
    <>
      <ShipBlockedReason reasons={blockers} />
      {missing.length > 0 ? <Alert status="warning" size="compact" message={`Answer the required ${missing.length === 1 ? "question" : "questions"} first: ${missing.map((other) => other.prompt).join("; ")}`} /> : null}
      {available ? null : <Typography variant="caption" color="secondary">This page is a snapshot: answer from the live console.</Typography>}
      {state.status === "failed" ? <Alert status="error" message={`Not sent: ${state.error}`} /> : null}
    </>
  );
}

/** The owner's picks, comments, round feedback, Addressed ticks and follow-up marks, held until the Ship or Send back press sends them. */
export function useSideAnswers() {
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState("");
  const [activeId, setActiveId] = useState<string>();
  const [addressed, setAddressed] = useState<number[]>([]);
  const [followUps, setFollowUps] = useState<string[]>([]);
  const toggleAddressed = (round: number, checked: boolean) => setAddressed((current) => [...current.filter((each) => each !== round), ...(checked ? [round] : [])]);
  const setFollowUp = (questionId: string, followUp: boolean) => setFollowUps((current) => [...current.filter((each) => each !== questionId), ...(followUp ? [questionId] : [])]);
  return { answers, comments, setComments, general, setGeneral, activeId, setActiveId, setAnswers, addressed, toggleAddressed, followUps, setFollowUp };
}

export type SideAnswers = ReturnType<typeof useSideAnswers>;

interface SideQuestionProps {
  round: ValidRound;
  question: Question;
  position: number;
  side: SideAnswers;
}

export function SideQuestion({ round, question, position, side }: SideQuestionProps): ReactNode {
  const { answers, comments, setComments, activeId, setActiveId, setAnswers } = side;
  const { notes } = round;
  return (
    <VStack gap={2}>
      <RoundQuestion
        question={question}
        position={position}
        answer={answers[question.id]}
        onChoose={(choice) => setAnswers((current) => ({ ...current, [question.id]: chooseIn(question, current[question.id], choice) }))}
        onText={(text) => setAnswers((current) => ({ ...current, [question.id]: { text } }))}
        active={question.id === activeId}
        onActivate={() => setActiveId(question.id)}
      />
      <RoundComment
        question={question}
        value={comments[question.id] ?? ""}
        onChange={(text) => setComments((current) => ({ ...current, [question.id]: text }))}
        sent={notes && (notes.comments[question.id] ?? "")}
      />
      <SideStake round={round} question={question} side={side} />
    </VStack>
  );
}

/** Open, the question's Ship stake and This PR or Follow-up choice; sent, whether it went as a follow-up. */
function SideStake({ round, question, side }: { round: ValidRound; question: Question; side: SideAnswers }): ReactNode {
  if (round.notes !== undefined) return round.followUps?.includes(question.id) ? <SentFollowUp questionId={question.id} /> : null;
  const [answer] = submittedAnswers([question], side.answers, side.comments);
  const followUp = side.followUps.includes(question.id);
  return <ShipStake manifest={round.manifest} question={question} answer={answer} followUp={followUp} onFollowUp={(next) => side.setFollowUp(question.id, next)} />;
}
