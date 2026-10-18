import { type ReactNode } from "react";
import { Alert, BreadcrumbItem, Breadcrumbs, DateTime, HStack, Heading, Pill, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { RoundDetail } from "../../server/rounds.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";
import { DesignRound } from "./RoundDesign.js";
import { RoundSections, orderedQuestions, useRoundAnswers } from "./RoundSections.js";
import { ShipRound } from "./RoundShip.js";

type ValidRound = Extract<RoundDetail, { valid: true }>;

/** One round: a merge gate's Ship view, a design round's frames, or its sections with each question answerable by pointer or keys 1-9. */
export function RoundDetailPage({ id }: { id: string }): ReactNode {
  const detail = useQuery("rounds.get", { id });
  if (detail.status === "loading") return <Spinner size="sm" label="Loading round" />;
  if (detail.data === undefined) return <Framed id={id}><Alert status="error" message={`Could not load ${id}: ${detail.error.message}`} /></Framed>;
  const round = detail.data;
  if (!round.valid) return <Framed id={id}><Alert status="error" message={`This round does not pass the round schema: ${round.reason}`} /></Framed>;
  return (
    <Framed id={id}>
      <RoundHeading round={round} />
      <RoundBody round={round} />
    </Framed>
  );
}

function RoundBody({ round }: { round: ValidRound }): ReactNode {
  if (round.ship) return <ShipRound round={round} />;
  return round.design ? <DesignRound round={round} /> : <QuestionRound round={round} />;
}

function Framed({ id, children }: { id: string; children: ReactNode }): ReactNode {
  return (
    <VStack gap={4}>
      <Breadcrumbs>
        <BreadcrumbItem onPress={() => open({ view: "rounds" })}>Rounds</BreadcrumbItem>
        <BreadcrumbItem isCurrentPage>{id}</BreadcrumbItem>
      </Breadcrumbs>
      {children}
    </VStack>
  );
}

function RoundHeading({ round }: { round: ValidRound }): ReactNode {
  const { manifest } = round;
  return (
    <VStack gap={1}>
      <HStack gap={3} align="center" wrap>
        <Heading level={3}>{`${manifest.unit} · round ${manifest.round}`}</Heading>
        <Pill variant="subtle" size="xs">{round.status}</Pill>
        <DateTime value={round.updatedAt} format="datetime" variant="caption" color="secondary" fallback="unknown" />
      </HStack>
      {manifest.context ? <Typography variant="body2" color="secondary">{manifest.context}</Typography> : null}
    </VStack>
  );
}

function QuestionRound({ round }: { round: ValidRound }): ReactNode {
  const state = useRoundAnswers(orderedQuestions(round.manifest).flatMap((group) => group.questions));
  return (
    <VStack gap={4}>
      <Alert status="info" size="compact" message="Read-only: picks stay in this page and are not sent." />
      {round.recommendationsWithheld ? <Typography variant="caption" color="secondary">Recommendations show once the round is answered.</Typography> : null}
      <RoundSections manifest={round.manifest} state={state} />
    </VStack>
  );
}
