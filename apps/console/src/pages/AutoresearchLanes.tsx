import type { ReactNode } from "react";
import { Badge, BadgeText, Card, CardContent, HStack, Link, Pill, Section, SectionContent, SectionHeader, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { ArLadder, ArRunView } from "../../server/autoresearch-view.js";
import { href, open, useRoute } from "../router.js";
import { AutoresearchIdeaDrawer, ImplementerLink } from "./AutoresearchIdeaDrawer.js";
import { AutoresearchLanesBoard } from "./AutoresearchLanesBoard.js";
import { AutoresearchStageStrip } from "./AutoresearchStageStepper.js";
import { shortId, signed } from "./autoresearch-format.js";
import { STAGES, boardLadders, currentStage, ideaFromQuery, ideaRoute, stageSpans } from "./autoresearch-lanes.js";
import { useNow, useRunPoll } from "./autoresearch-live.js";

/** Design §1.3: the current round's ideas, one card each, in the column of the stage they are in. */
export function AutoresearchLanes({ run }: { run: ArRunView }): ReactNode {
  useRunPoll(run.status);
  const route = useRoute();
  const onBoard = boardLadders(run);
  const now = useNow(onBoard.some((ladder) => ladder.active !== null));
  const columns = STAGES.map((stage) => ({
    key: stage.key,
    label: stage.label,
    items: onBoard.filter((ladder) => currentStage(ladder) === stage.key).map((ladder) => ({ key: ladder.idea.id, node: <LaneCard run={run} ladder={ladder} now={now} /> })),
  }));
  return (
    <Section testID="autoresearch-lanes">
      <SectionHeader title="Live lanes" subtitle={`Round ${run.rounds.at(-1)?.round ?? 0} · ${onBoard.length} on the board · every card passed its bounds pre-check when queued`} />
      <SectionContent>
        <AutoresearchLanesBoard columns={columns} />
      </SectionContent>
      <AutoresearchIdeaDrawer run={run} ideaId={ideaFromQuery(route.query)} now={now} />
    </Section>
  );
}

function LaneCard({ run, ladder, now }: { run: ArRunView; ladder: ArLadder; now: number }): ReactNode {
  const { idea, active, outcome } = ladder;
  const details = ideaRoute(run.runId, idea.id);
  return (
    <Card variant="outline" testID={`autoresearch-card-${idea.id}`}>
      <CardContent>
        <VStack gap={2}>
          <HStack gap={2} align="center" wrap>
            {active === null ? null : <Spinner size="sm" label={`${shortId(idea.id)} is running`} />}
            <Typography variant="boldLabel">{`${shortId(idea.id)} ${idea.cell}`}</Typography>
            <Pill variant="subtle" size="xs" tone="neutral">{idea.source}</Pill>
            {idea.bold ? <Pill variant="subtle" size="xs" tone="brand">bold</Pill> : null}
            {active !== null && active.restarts > 0 ? <RestartBadge restarts={active.restarts} /> : null}
          </HStack>
          <Typography variant="caption" color="secondary">{idea.hypothesis}</Typography>
          <AutoresearchStageStrip spans={stageSpans(ladder, now).filter((span) => span.state !== "upcoming")} testID={`autoresearch-card-stages-${idea.id}`} />
          {outcome === null ? null : <Typography variant="caption">{outcomeText(outcome)}</Typography>}
          <HStack gap={3} wrap>
            <ImplementerLink ladder={ladder} />
            <Link color="primary" href={href(details)} onPress={() => open(details)} testID={`autoresearch-card-details-${idea.id}`}>
              Details
            </Link>
          </HStack>
        </VStack>
      </CardContent>
    </Card>
  );
}

function RestartBadge({ restarts }: { restarts: number }): ReactNode {
  return (
    <Badge color="warning" variant="subtle" size="sm">
      <BadgeText>{`restarted ×${restarts}`}</BadgeText>
    </Badge>
  );
}

const outcomeText = (outcome: NonNullable<ArLadder["outcome"]>): string =>
  `${outcome.verdict} at ${outcome.rungReached} · ${outcome.reason}${outcome.delta === undefined ? "" : ` · Δ ${signed(outcome.delta)}pp`}`;
