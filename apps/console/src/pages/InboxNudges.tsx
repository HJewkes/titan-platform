import { useState, type ReactNode } from "react";
import { Alert, Badge, BadgeText, Button, ButtonText, Card, CardContent, HStack, Link, Pill, Section, SectionContent, SectionHeader, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useInvalidate } from "../data/rpc.js";
import { useAnswerSource } from "../data/submit.js";
import { open } from "../router.js";
import { PHONE_TAP, PHONE_TAP_LINK } from "./phone.js";
import { useConfirmOnPhone } from "./PhoneConfirm.js";

type RoundNudge = ConsoleCommands["inbox.list"]["result"]["nudges"][number];

type TapState = { status: "idle" | "sending" } | { status: "sent"; already: boolean } | { status: "failed"; error: string };

const alreadySubmitted = (data: unknown): boolean => typeof data === "object" && data !== null && "status" in data && data.status === "already-submitted";

/**
 * Rounds left open over six hours, one row each, with the recommendations stated and, where every question has one, the
 * one tap. An after-answer round states none: its owner answers blind, so its tap accepts recommendations unseen.
 */
export function NudgeSection({ nudges }: { nudges: readonly RoundNudge[] }): ReactNode {
  return (
    <Section testID="inbox-nudges">
      <SectionHeader title={`Waiting over 6 h (${nudges.length})`} subtitle="Rounds with no answer yet" />
      <SectionContent>
        <VStack gap={3}>
          {nudges.map((nudge) => (
            <NudgeCard key={nudge.roundId} nudge={nudge} />
          ))}
        </VStack>
      </SectionContent>
    </Section>
  );
}

function NudgeCard({ nudge }: { nudge: RoundNudge }): ReactNode {
  return (
    <Card variant="outline" testID={`inbox-nudge-${nudge.roundId}`}>
      <CardContent>
        <VStack gap={2}>
          <Typography variant="subtitle2">{nudge.line}</Typography>
          <HStack gap={2} align="center" wrap>
            <Badge color="warning" variant="subtle" size="sm">
              <BadgeText>{`round ${nudge.round}`}</BadgeText>
            </Badge>
            {nudge.recommendations.map((each) => (
              <Pill key={each.questionId} variant="subtle" size="xs">{`${each.questionId}: ${each.answer}`}</Pill>
            ))}
          </HStack>
          <Link color="primary" className={PHONE_TAP_LINK} onPress={() => open({ view: "rounds", id: nudge.roundId })}>
            Open round
          </Link>
          {nudge.oneTap ? <RecTap nudge={nudge} /> : <Typography variant="caption" color="secondary">{`No one-tap answer: ${nudge.withoutTap ?? "unknown"}`}</Typography>}
        </VStack>
      </CardContent>
    </Card>
  );
}

const recLabel = (nudge: RoundNudge): string => (nudge.recommendationsHidden ? "Accept all recommendations (unseen)" : "Answer all with recommendation");

/**
 * One tap, as the nudge promised: `rounds.answer-rec` hands the recommendations to `rounds.submit`. On a phone the tap
 * only arms a confirm step, since a thumb lands on it while scrolling.
 */
function RecTap({ nudge }: { nudge: RoundNudge }): ReactNode {
  const source = useAnswerSource();
  const invalidate = useInvalidate();
  const [state, setState] = useState<TapState>({ status: "idle" });
  const tap = async (): Promise<void> => {
    if (source === null) return;
    setState({ status: "sending" });
    const envelope = await source.call("rounds.answer-rec", { id: nudge.roundId, manifestSha256: nudge.manifestSha256 });
    if (!envelope.ok) return setState({ status: "failed", error: envelope.error });
    setState({ status: "sent", already: alreadySubmitted(envelope.data) });
    invalidate(["inbox.list", "rounds.get", "rounds.list"]);
  };
  const detail = `${recLabel(nudge)} for round ${nudge.round}? This submits the round.`;
  const { press, step } = useConfirmOnPhone([{ id: "rec", confirm: "Confirm", detail, isDisabled: state.status === "sending", run: () => void tap() }]);
  if (source === null) return <Typography variant="caption" color="secondary">This page is a snapshot: answer from the live console.</Typography>;
  if (state.status === "sent") return <Alert status="success" message={state.already ? "This round was already answered." : "Answered with every recommendation."} />;
  return (
    <VStack gap={2}>
      <Button size="sm" className={PHONE_TAP} isDisabled={state.status === "sending"} onPress={() => press("rec")} testID={`inbox-nudge-rec-${nudge.roundId}`}>
        <ButtonText>{recLabel(nudge)}</ButtonText>
      </Button>
      {step}
      {state.status === "failed" ? <Alert status="error" message={`Not answered: ${state.error}`} /> : null}
    </VStack>
  );
}
