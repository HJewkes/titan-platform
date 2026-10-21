import type { ReactNode } from "react";
import { Alert, Typography } from "@titan-design/react-ui";
import type { RoundDetail } from "../../server/rounds.js";
import type { Manifest, Question } from "../../server/round-schema.js";
import type { ShipBlocker } from "../../server/ship-blockers.js";
import type { SubmitState } from "../data/submit.js";
import { asksRevision, submittedAnswers } from "./RoundAnswers.js";
import { RoundComment } from "./RoundComment.js";
import { LockedQuestion, sentComment, unlessLocked } from "./RoundLock.js";
import { RoundQuestion } from "./RoundQuestion.js";
import { abAnswering, type RoundAnswers } from "./RoundSections.js";
import { ShipBlockedReason } from "./ShipPriorFeedback.js";
import { SentFollowUp, ShipStake } from "./ShipStake.js";
import { ShipTarget } from "./ShipTabs.js";
import { shipsAfter } from "./ship-stack.js";

type ValidRound = Extract<RoundDetail, { valid: true }>;

/** The Addressed ticks and follow-up marks as `rounds.submit` args, each left out when empty. */
export function sideMarks(side: RoundAnswers) {
  return {
    addressed: side.addressed.length > 0 ? { addressed: side.addressed } : {},
    followUps: side.followUps.length > 0 ? { followUps: side.followUps } : {},
  };
}

interface ShipNoticesProps {
  blockers: ShipBlocker[];
  noNote: string | undefined;
  available: boolean;
  state: SubmitState;
}

export function ShipNotices({ blockers, noNote, available, state }: ShipNoticesProps): ReactNode {
  return (
    <>
      <ShipBlockedReason reasons={blockers} />
      {noNote ? <Alert status="warning" size="compact" message={noNote} testID="send-back-blocked" /> : null}
      {available ? null : <Typography variant="caption" color="secondary">This page is a snapshot: answer from the live console.</Typography>}
      {state.status === "failed" ? <Alert status="error" message={`Not sent: ${state.error}`} /> : null}
    </>
  );
}

/** A stacked PR's Ship merges only once the PR under it has (decision 95(3)). */
export function ShipsAfterNote({ manifest, question }: { manifest: Manifest; question: Question }): ReactNode {
  const holder = shipsAfter(manifest, question);
  return holder === undefined ? null : <Typography variant="caption" color="secondary" testID={`ships-after-${question.id}`}>{`ships after ${holder}`}</Typography>;
}

export function NothingToReview(): ReactNode {
  return <Typography variant="body2" color="secondary">Nothing to answer here but Ship: the changes are in Diff, the PR in Context.</Typography>;
}

interface SideQuestionProps {
  round: ValidRound;
  question: Question;
  position: number;
  side: RoundAnswers;
  /** Sent or sending: the answer shows as given and takes no more edits. */
  locked: boolean;
}

export function SideQuestion({ round, question, position, side, locked }: SideQuestionProps): ReactNode {
  const { answers, comments, activeId, setActiveId, choose, write, comment } = side;
  return (
    <ShipTarget target={{ kind: "question", id: question.id }}>
      <LockedQuestion locked={locked} testID={`ship-side-${question.id}`}>
        <RoundQuestion
          question={question}
          position={position}
          answer={answers[question.id]}
          onChoose={unlessLocked(locked, (choice: string) => choose(question, choice))}
          onText={unlessLocked(locked, (text: string) => write(question, text))}
          active={!locked && question.id === activeId}
          onActivate={unlessLocked(locked, () => setActiveId(question.id))}
          ab={abAnswering(side, question, locked)}
        />
        <RoundComment question={question} value={comments[question.id] ?? ""} onChange={unlessLocked(locked, (text: string) => comment(question, text))} sent={sentComment(comments, question, locked)} revising={asksRevision(question, answers[question.id])} />
        <SideStake round={round} question={question} side={side} locked={locked} />
      </LockedQuestion>
    </ShipTarget>
  );
}

/** Open, the question's Ship stake and This PR or Follow-up choice; sent, whether it went as a follow-up. */
function SideStake({ round, question, side, locked }: { round: ValidRound; question: Question; side: RoundAnswers; locked: boolean }): ReactNode {
  const followUps = round.notes !== undefined ? (round.followUps ?? []) : side.followUps;
  if (locked) return followUps.includes(question.id) ? <SentFollowUp questionId={question.id} /> : null;
  const [answer] = submittedAnswers([question], side.answers, side.comments);
  return <ShipStake manifest={round.manifest} question={question} answer={answer} followUp={followUps.includes(question.id)} onFollowUp={(next) => side.setFollowUp(question.id, next)} />;
}
