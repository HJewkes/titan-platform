import type { ReactNode } from "react";
import {
  Alert,
  Badge,
  BadgeText,
  Button,
  ButtonText,
  EmptyState,
  HStack,
  Section,
  SectionContent,
  SectionHeader,
  StatCard,
  StatCardFigure,
  StatCardHeader,
  Typography,
  VStack,
} from "@titan-design/react-ui";
import type { ScorecardWeek } from "../../server/scorecard-schema.js";
import { useQuery } from "../data/rpc.js";
import { replace } from "../router.js";
import { Spinner } from "../shell/Loading.js";
import { FactoryHealthSection } from "./ScorecardFactoryHealth.js";
import { BreakdownSection, PhaseSection, WeekFigures } from "./ScorecardTables.js";
import { AuditSetCard, InferredBadge, InferredReview, WeekTasks } from "./ScorecardTasks.js";
import { allCell, flagText, hoursText, shareText, shortWeek, usdText } from "./scorecard-format.js";
import { PHONE_TAP } from "./phone.js";

const ISO_WEEK = /^\d{4}-W\d{2}$/;

function weekFrom(query: string | undefined): string | undefined {
  const week = new URLSearchParams(query ?? "").get("week");
  return week !== null && ISO_WEEK.test(week) ? week : undefined;
}

const showWeek = (week: string): void => replace({ view: "scorecard", query: `week=${week}` });

/**
 * The ticket scorecard (TP-5446): a week strip, the chosen week's headline figures and red flags, its breakdowns,
 * and the tasks behind them. Every figure is the scorecard job's own; the page computes none and writes nothing.
 */
export function ScorecardPage({ query }: { query?: string }): ReactNode {
  const weeks = useQuery("scorecard.weeks");
  if (weeks.status === "loading") return <Spinner size="sm" label="Loading the scorecard" />;
  if (weeks.data === undefined) return <Alert status="error" message={`Could not load the scorecard: ${weeks.error.message}`} />;
  const { store } = weeks.data;
  if (store.state !== "ok") return <EmptyState title={`Scorecard ${store.state}`} description={store.detail} />;
  if (weeks.data.weeks.length === 0) return <EmptyState title="No week scored yet" description="The ticket-scorecard job has stored no weekly figures." />;
  const asked = weekFrom(query);
  const week = weeks.data.weeks.find((w) => w.isoWeek === asked) ?? weeks.data.weeks[0]!;
  return (
    <VStack gap={6}>
      <WeekStrip weeks={weeks.data.weeks} selected={week.isoWeek} />
      <WeekHeadline week={week} />
      <WeekFigures week={week} />
      <BreakdownSection week={week} dimension="seat" title="Seats" empty="Not measured: seats are told apart once spawns record their dispatch rule (F12)." />
      <BreakdownSection week={week} dimension="dispatcher" title="Dispatchers" empty="No dispatcher this week." />
      <BreakdownSection week={week} dimension="initiative" title="Initiatives" empty="No initiative this week." />
      <PhaseSection week={week} />
      <FactoryHealthSection week={week} />
      <WeekTasks week={week.isoWeek} />
      <InferredReview />
      <AuditSetCard />
    </VStack>
  );
}

/** Newest week first; on a phone the strip scrolls inside itself rather than widening the page. */
function WeekStrip({ weeks, selected }: { weeks: readonly ScorecardWeek[]; selected: string }): ReactNode {
  return (
    <HStack gap={2} className="flex-nowrap overflow-x-auto pb-1" testID="scorecard-week-strip">
      {weeks.map((week) => {
        const flags = allCell(week)?.redFlags.length ?? 0;
        return (
          <Button
            key={week.isoWeek}
            size="sm"
            variant={week.isoWeek === selected ? "solid" : "outline"}
            color={flags > 0 ? "error" : "primary"}
            className={`${PHONE_TAP} shrink-0`}
            onPress={() => showWeek(week.isoWeek)}
            testID={`scorecard-week-${week.isoWeek}`}
          >
            <ButtonText>{flags > 0 ? `${shortWeek(week.isoWeek)} · ${flags} red` : shortWeek(week.isoWeek)}</ButtonText>
          </Button>
        );
      })}
    </HStack>
  );
}

function WeekState({ week }: { week: ScorecardWeek }): ReactNode {
  return (
    <HStack gap={1} wrap>
      <Badge color={week.frozen ? "default" : "info"} variant="subtle" size="sm">
        <BadgeText>{week.frozen ? "frozen" : "open"}</BadgeText>
      </Badge>
      {week.drift ? (
        <Badge color="warning" variant="subtle" size="sm">
          <BadgeText>drift</BadgeText>
        </Badge>
      ) : null}
    </HStack>
  );
}

/** The six numbers the digest leads with, then the week's red flags; a label resting on inference says so. */
function WeekHeadline({ week }: { week: ScorecardWeek }): ReactNode {
  const cell = allCell(week);
  return (
    <Section testID="scorecard-headline">
      <SectionHeader title={`Week ${week.isoWeek}`} subtitle="All dispatched tasks" trailing={<WeekState week={week} />} />
      <SectionContent>
        {cell === undefined ? (
          <EmptyState title="No dispatch this week" />
        ) : (
          <VStack gap={3}>
            <RedFlags flags={cell.redFlags} />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat id="dispatched" label="Dispatched" figure={String(cell.metrics.dispatched)} />
              <Stat id="merged" label="Merged" figure={String(cell.metrics.merged)} />
              <Stat id="upkeep" label="Upkeep share" figure={shareText(cell.metrics.upkeepShare)} inferred={cell.metrics.inferredShare} />
              <Stat id="owner" label="Owner-sourced" figure={shareText(cell.metrics.ownerSourcedShare)} inferred={cell.metrics.inferredShare} />
              <Stat id="lead" label="Dispatch to merge" figure={hoursText(cell.metrics.leadDispatchMergeMedianH)} caption={`median · p90 ${hoursText(cell.metrics.leadDispatchMergeP90H)}`} />
              <Stat id="cost" label="Cost per merge" figure={usdText(cell.metrics.costPerMerged)} />
            </div>
          </VStack>
        )}
      </SectionContent>
    </Section>
  );
}

function RedFlags({ flags }: { flags: readonly string[] }): ReactNode {
  if (flags.length === 0) return <Typography variant="body2" color="secondary">No red flag this week.</Typography>;
  return (
    <HStack gap={1} wrap testID="scorecard-red-flags">
      {flags.map((flag) => (
        <Badge key={flag} color="error" variant="solid" size="sm">
          <BadgeText>{flagText(flag)}</BadgeText>
        </Badge>
      ))}
    </HStack>
  );
}

interface StatProps {
  id: string;
  label: string;
  figure: string;
  caption?: string;
  /** The week's inferred share; above zero, the figure rests partly on inferred labels and carries the badge. */
  inferred?: number | null;
}

function Stat({ id, label, figure, caption, inferred }: StatProps): ReactNode {
  const badge = inferred !== undefined && inferred !== null && inferred > 0 ? <InferredBadge testID={`scorecard-stat-${id}-inferred`} /> : undefined;
  return (
    <StatCard
      testID={`scorecard-stat-${id}`}
      inset="md"
      captionPlacement="below"
      header={<StatCardHeader title={label} trailing={badge} />}
      figure={<StatCardFigure value={figure} />}
      caption={
        caption === undefined ? undefined : (
          <Typography variant="body2" color="secondary">
            {caption}
          </Typography>
        )
      }
    />
  );
}
