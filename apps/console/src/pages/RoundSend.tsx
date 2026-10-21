import type { ReactNode } from "react";
import { Alert, Button, ButtonText, Card, CardContent, Typography, VStack } from "@titan-design/react-ui";
import type { RoundDetail } from "../../server/rounds.js";
import { useSubmit } from "../data/submit.js";
import { inOrder, submittedAnswers } from "./RoundAnswers.js";
import { RoundCheck, useSendCheck, type SendCheck } from "./RoundCheck.js";
import { RoundGeneral, SentGeneral } from "./RoundComment.js";
import type { PostedVariant } from "./frame-feedback.js";
import { useWithSeen } from "./RoundReveal.js";
import type { RoundAnswers } from "./RoundSections.js";
import { checkGroups, sendProblems } from "./round-check.js";

type ValidRound = Extract<RoundDetail, { valid: true }>;

type Submitting = ReturnType<typeof useSubmit>;

/** Sent or sending, the round's questions lock: the page's own state until a reload, then feedback.json's. */
const lockedBy = (round: ValidRound, { state }: Submitting): boolean => round.status === "sent" || state.status === "sending" || state.status === "sent";

/** Sent, by an earlier visit or this one: the round shows what it sent, and no check screen stands in for it. */
const sentBy = (round: ValidRound, { state }: Submitting): boolean => round.status === "sent" || state.status === "sent";

/**
 * A round's send: the submit, the check screen, and whether the page is locked (sent or sending) or frozen (also while
 * the check screen is open, so no key changes an answer the screen is showing).
 */
export function useRoundSend(round: ValidRound) {
  const submitting = useSubmit();
  const check = useSendCheck();
  const locked = lockedBy(round, submitting);
  const checking = check.open && !sentBy(round, submitting);
  return { submitting, check, checking, locked, frozen: locked || checking };
}

interface RoundSendProps {
  round: ValidRound;
  state: RoundAnswers;
  submitting: Submitting;
  check: SendCheck;
  /** A design round's frame verdicts and comments; a page without frames to judge sends none. */
  variants?: PostedVariant[];
}

/**
 * The send card of a design or question round, and the check screen it opens: all answers and the round's feedback go
 * in one `rounds.submit`, required questions answered or not (owner decision 513), once the owner has checked them.
 */
export function RoundSend({ round, state, submitting, check, variants }: RoundSendProps): ReactNode {
  const { available, state: sending, submit } = submitting;
  const withSeen = useWithSeen();
  if (round.status === "withdrawn") return <Alert status="warning" message="Withdrawn: a newer round replaced this one." />;
  if (sentBy(round, submitting)) return <SentNotice round={round} already={sending.status === "sent" && sending.already} />;
  const answers = withSeen(submittedAnswers(round.manifest.questions, state.answers, state.comments, state.optionNotes));
  const general = state.general.trim();
  const canSend = available && sending.status !== "sending";
  if (check.open) {
    const send = () => void submit({ id: round.id, manifestSha256: round.manifestSha256, general, answers: inOrder(round.manifest, answers), ...(variants && { variants }) });
    const failed = sending.status === "failed" ? sending.error : undefined;
    return <RoundCheck manifest={round.manifest} groups={checkGroups(round.manifest, answers, variants)} general={general} check={check} onSend={canSend ? send : undefined} problems={sendProblems(round.manifest.questions, answers)} failed={failed} />;
  }
  return (
    <Card variant="outline">
      <CardContent>
        <VStack gap={3}>
          <RoundGeneral value={state.general} onChange={state.setGeneral} />
          <Button color="primary" isDisabled={!canSend} onPress={check.show}><ButtonText>Check and send</ButtonText></Button>
          {available ? null : <Typography variant="caption" color="secondary">This page is a snapshot: answer from the live console.</Typography>}
          {sending.status === "failed" ? <Alert status="error" message={`Not sent: ${sending.error}`} /> : null}
        </VStack>
      </CardContent>
    </Card>
  );
}

function SentNotice({ round, already }: { round: ValidRound; already: boolean }): ReactNode {
  return (
    <VStack gap={3}>
      <Alert status="success" message={already ? "Already answered" : "Answers sent"} />
      <SentGeneral text={round.notes?.general} />
    </VStack>
  );
}
