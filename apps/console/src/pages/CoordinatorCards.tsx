import type { ReactNode } from "react";
import { Alert, Badge, BadgeText, Card, CardContent, HStack, Link, Section, SectionContent, SectionHeader, Skeleton, Typography, VStack } from "@titan-design/react-ui";
import { useQuery, type ServedCommands } from "../data/rpc.js";
import { open } from "../router.js";
import { useMediaQuery } from "./FramePins.js";
import { openExternal } from "./homeLinks.js";
import { BELOW_MD, PHONE_TAP_ID_LINK, PHONE_TAP_LINK } from "./phone.js";

type CardsResult = ServedCommands["coord.cards"]["result"];
type CoordinatorCard = CardsResult["cards"][number];
type PrRef = CardsResult["unattributed"][number];
type DayArgs = ServedCommands["coord.cards"]["args"];

const CARD_SKELETONS = 3;

/** A null cost means no agent's exit row reported one, which is not the same as spending nothing. */
const costLabel = (costUsd: number | null): string => (costUsd === null ? "n/a" : `$${costUsd.toFixed(2)}`);

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** One card per coordinator that spawned agents or owns a merged PR in the day, and one for the PRs no coordinator can be named for. */
export function CoordinatorCards({ day }: { day: DayArgs }): ReactNode {
  const cards = useQuery("coord.cards", day);
  return (
    <Section>
      <SectionHeader title="Coordinators" subtitle="Agents each coordinator spawned this day, and the PRs Shepherd merged for them" />
      <SectionContent>
        {cards.status === "loading" ? (
          <CardsSkeleton />
        ) : cards.data === undefined ? (
          <Alert status="error" message={`Could not load the coordinator cards: ${cards.error.message}`} testID="coord-cards-error" />
        ) : (
          <CardsBody result={cards.data} />
        )}
      </SectionContent>
    </Section>
  );
}

function CardsSkeleton(): ReactNode {
  return (
    <VStack gap={3} testID="coord-cards-loading">
      {Array.from({ length: CARD_SKELETONS }, (_, index) => (
        <Skeleton key={index} variant="rounded" width="100%" height={96} accessibilityLabel={index === 0 ? "Loading the coordinator cards" : undefined} />
      ))}
    </VStack>
  );
}

function CardsBody({ result }: { result: CardsResult }): ReactNode {
  const isPhone = useMediaQuery(BELOW_MD);
  const isEmpty = result.cards.length === 0 && result.unattributed.length === 0;
  return (
    <VStack gap={4}>
      {result.gaps.map((gap) => (
        <Alert key={gap} status="warning" message={gap} testID="coord-cards-gap" />
      ))}
      {isEmpty ? (
        <Typography variant="body2" color="secondary" testID="coord-cards-empty">
          No coordinator spawned an agent this day, and Shepherd merged no PR in it.
        </Typography>
      ) : (
        <div className={isPhone ? "flex flex-col gap-3" : "grid grid-cols-2 gap-4 xl:grid-cols-3"} data-testid={isPhone ? "coord-cards-stack" : "coord-cards-grid"}>
          {result.cards.map((card) => (
            <CoordinatorCardView key={card.coordinator} card={card} />
          ))}
          {result.unattributed.length === 0 ? null : <UnattributedCard prs={result.unattributed} />}
        </div>
      )}
    </VStack>
  );
}

function CoordinatorCardView({ card }: { card: CoordinatorCard }): ReactNode {
  return (
    <Card variant="outline" className="min-w-0" testID={`coord-card-${card.coordinator}`}>
      <CardContent>
        <VStack gap={2} className="min-w-0">
          <HStack gap={2} align="center" className="min-w-0 flex-wrap">
            <Typography variant="subtitle1" className="break-words">
              {card.coordinator}
            </Typography>
            {card.seat === null ? null : (
              <Badge color="info" variant="subtle" size="sm" testID={`coord-card-seat-${card.coordinator}`}>
                <BadgeText>{`seat ${card.seat}`}</BadgeText>
              </Badge>
            )}
          </HStack>
          <Typography variant="caption" color="secondary" testID={`coord-card-stats-${card.coordinator}`}>
            {`${plural(card.agentsRun, "agent", "agents")} run · ${card.liveNow} live now · ${costLabel(card.costUsd)}`}
          </Typography>
          <PrList prs={card.prsMerged} empty="No PR merged through Shepherd" />
          <TaskList tasks={card.tasks} />
        </VStack>
      </CardContent>
    </Card>
  );
}

function UnattributedCard({ prs }: { prs: readonly PrRef[] }): ReactNode {
  return (
    <Card variant="outline" className="min-w-0" testID="coord-card-unattributed">
      <CardContent>
        <VStack gap={2} className="min-w-0">
          <Typography variant="subtitle1">Unattributed</Typography>
          <Typography variant="caption" color="secondary">
            Merged through Shepherd, but no spawn row names exactly one coordinator for them, so none is guessed.
          </Typography>
          <PrList prs={prs} empty="" />
        </VStack>
      </CardContent>
    </Card>
  );
}

function PrList({ prs, empty }: { prs: readonly PrRef[]; empty: string }): ReactNode {
  if (prs.length === 0) return empty === "" ? null : <Typography variant="caption" color="secondary">{empty}</Typography>;
  return (
    <VStack gap={1} className="min-w-0">
      {prs.map((pr) => (
        <HStack key={`${pr.repo}#${pr.number}`} gap={2} align="center" className="min-w-0 flex-wrap">
          <Link color="primary" href={pr.url} isExternal className={`${PHONE_TAP_LINK} break-all`} onPress={() => openExternal(pr.url)} testID={`coord-pr-${pr.repo}#${pr.number}`}>
            {`${pr.repo}#${pr.number}`}
          </Link>
          <Typography variant="caption" color="secondary" className="break-words">
            {pr.task}
          </Typography>
        </HStack>
      ))}
    </VStack>
  );
}

function TaskList({ tasks }: { tasks: CoordinatorCard["tasks"] }): ReactNode {
  if (tasks.length === 0) return null;
  return (
    <VStack gap={1} className="min-w-0">
      {tasks.map((task) => (
        <HStack key={task.id} gap={2} align="center" className="min-w-0">
          <Link color="primary" className={PHONE_TAP_ID_LINK} onPress={() => open({ view: "tasks", id: task.id })}>
            {task.id}
          </Link>
          {task.title === undefined ? null : (
            <Typography variant="body2" className="min-w-0 break-words">
              {task.title}
            </Typography>
          )}
        </HStack>
      ))}
    </VStack>
  );
}
