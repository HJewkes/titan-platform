import { useMemo, type ReactNode } from "react";
import { Alert, Button, ButtonText, Card, CardContent, Typography, VStack } from "@titan-design/react-ui";
import type { RoundDetail } from "../../server/rounds.js";
import { useSubmit } from "../data/submit.js";
import { inOrder, submittedAnswers } from "./RoundAnswers.js";
import { RoundCheck, useSendCheck, type SendCheck } from "./RoundCheck.js";
import { RoundGeneral, SentGeneral } from "./RoundComment.js";
import type { DraftBinding } from "./RoundDraft.js";
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
 * A round's send: the submit, the check screen, whether the page is locked (sent or sending) or frozen (also while
 * the check screen is open, so no key changes an answer the screen is showing), and the draft it keeps until sent.
 */
export function useRoundSend(round: ValidRound) {
  const submitting = useSubmit();
  const check = useSendCheck();
  const locked = lockedBy(round, submitting);
  const sent = sentBy(round, submitting);
  const checking = check.open && !sent;
  const draft = useDraftBinding(round, sent);
  // The keys open the check screen only where the "Check and send" button could.
  const review = submitting.available && round.status === "open" && !locked && !checking ? check.show : undefined;
  return { submitting, check, checking, locked, frozen: locked || checking, draft, review };
}

/** The round's draft binding: closed once `sent`, on this visit or an earlier one, or withdrawn. */
export function useDraftBinding(round: ValidRound, sent: boolean): DraftBinding {
  const closed = sent || round.status !== "open";
  return useMemo(() => ({ roundId: round.id, manifestSha256: round.manifestSha256, closed }), [round.id, round.manifestSha256, closed]);
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
