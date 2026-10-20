import type { ReactNode } from "react";
import { Alert, Button, ButtonText, Card, CardContent, Typography, VStack } from "@titan-design/react-ui";
import type { RoundDetail } from "../../server/rounds.js";
import type { useSubmit } from "../data/submit.js";
import { inOrder, missingRequired, submittedAnswers } from "./RoundAnswers.js";
import { RoundGeneral, SentGeneral } from "./RoundComment.js";
import type { RoundAnswers } from "./RoundSections.js";

type ValidRound = Extract<RoundDetail, { valid: true }>;

type Submitting = ReturnType<typeof useSubmit>;

/** Sent or sending, the round's questions lock: the page's own state until a reload, then feedback.json's. */
export const lockedBy = (round: ValidRound, { state }: Submitting): boolean => round.status === "sent" || state.status === "sending" || state.status === "sent";

/** The send card of a design or question round: all answers and the round's feedback go in one `rounds.submit`, once the required questions hold one. */
export function RoundSend({ round, state, submitting }: { round: ValidRound; state: RoundAnswers; submitting: Submitting }): ReactNode {
  const { available, state: sending, submit } = submitting;
  if (round.status === "withdrawn") return <Alert status="warning" message="Withdrawn: a newer round replaced this one." />;
  if (round.status === "sent" || sending.status === "sent") return <SentNotice round={round} already={sending.status === "sent" && sending.already} />;
  const answers = submittedAnswers(round.manifest.questions, state.answers, state.comments, state.optionNotes);
  const missing = missingRequired(round.manifest.questions, answers);
  const send = () => submit({ id: round.id, manifestSha256: round.manifestSha256, general: state.general.trim(), answers: inOrder(round.manifest, answers) });
  return (
    <Card variant="outline">
      <CardContent>
        <VStack gap={3}>
          <RoundGeneral value={state.general} onChange={state.setGeneral} />
          <Button color="primary" isDisabled={!available || sending.status === "sending" || missing.length > 0} onPress={() => void send()}><ButtonText>Send answers</ButtonText></Button>
          {missing.length > 0 ? <Alert status="warning" size="compact" message={`Answer the required ${missing.length === 1 ? "question" : "questions"} first: ${missing.map((question) => question.prompt).join("; ")}`} /> : null}
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
