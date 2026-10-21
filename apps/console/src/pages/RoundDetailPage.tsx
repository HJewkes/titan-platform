import { type ReactNode } from "react";
import { Alert, BreadcrumbItem, Breadcrumbs, DateTime, HStack, Heading, Pill, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { RoundDetail } from "../../server/rounds.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";
import { RoundFramesProvider } from "./QuestionFrames.js";
import { RoundNote } from "./RoundNote.js";
import { RoundRevealProvider } from "./RoundReveal.js";
import { DesignRound } from "./RoundDesign.js";
import { RoundSend, useRoundSend } from "./RoundSend.js";
import { RoundSetNav } from "./RoundSetNav.js";
import { PagedSections } from "./RoundPager.js";
import { orderedQuestions, useRoundAnswers } from "./RoundSections.js";
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
  const body = round.ship ? <ShipRound round={round} /> : round.design ? <DesignRound round={round} /> : <QuestionRound round={round} />;
  return <RoundFramesProvider roundId={round.id} manifest={round.manifest}><RoundRevealProvider round={round}>{body}</RoundRevealProvider></RoundFramesProvider>;
}

function Framed({ id, children }: { id: string; children: ReactNode }): ReactNode {
  return (
    <VStack gap={4}>
      <Breadcrumbs>
        <BreadcrumbItem onPress={() => open({ view: "rounds" })}>Rounds</BreadcrumbItem>
        <BreadcrumbItem isCurrentPage>{id}</BreadcrumbItem>
      </Breadcrumbs>
      <RoundSetNav id={id} />
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
      {manifest.context ? <RoundNote heading="Context" text={manifest.context} /> : null}
    </VStack>
  );
}

function QuestionRound({ round }: { round: ValidRound }): ReactNode {
  const { submitting, check, checking, locked, frozen } = useRoundSend(round);
  // Frozen, no question is handed over, so no digit key can change an answer already sent or being checked.
  const state = useRoundAnswers(frozen ? [] : orderedQuestions(round.manifest).flatMap((group) => group.questions), round.notes, frozen);
  return (
    <VStack gap={4}>
      {round.recommendationsWithheld ? <Typography variant="caption" color="secondary">Recommendations are hidden until you answer; reveal one first with r.</Typography> : null}
      <PagedSections manifest={round.manifest} state={state} textAnswers locked={locked} check={check} checking={checking} send={<RoundSend round={round} state={state} submitting={submitting} check={check} />} />
    </VStack>
  );
}
