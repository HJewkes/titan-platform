import type { ReactNode } from "react";
import { EmptyState, Section, SectionContent, SectionHeader, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, VStack } from "@titan-design/react-ui";
import type { ScorecardFactoryHealth, ScorecardWeek } from "../../server/scorecard-schema.js";
import { Labelled } from "./ScorecardTasks.js";
import { NOT_MEASURED, numberText, shareText, usdText } from "./scorecard-format.js";

/** Below these widths a table scrolls inside its own box, so a phone never scrolls the page sideways. */
const TIER_MIN_WIDTH = 360;
const WAKE_MIN_WIDTH = 420;

/** Some of the week's filings rest on the backfill's inferred source label rather than a recorded field. */
const INFERRED_FILER = "inferred:source-label";

type Figure = [id: string, label: string, value: string, inferred?: boolean];

function figures(h: ScorecardFactoryHealth): Figure[] {
  const g = h.selfGenerated;
  const f = h.fenceStops;
  const inferred = g.agentFiledInferred > 0;
  return [
    ["per-closed", "Agent-filed tasks per task closed", numberText(g.perClosed), inferred],
    ["per-merged-pr", "Agent-filed tasks per merged PR", numberText(g.perMergedPr), inferred],
    ["refusals", "Spawn refusals per 100 dispatched", numberText(f.refusalsPer100)],
    ["holds", "Gate holds per 100 dispatched", numberText(f.holdsPer100)],
    ["guard-denials", "Guard denials per 100 dispatched", NOT_MEASURED],
    ["code-size", "Factory to product code size", NOT_MEASURED],
    ["upkeep", "Upkeep share of dispatch", shareText(h.covered.upkeepShare)],
    ["review-rounds", "Median review rounds", numberText(h.covered.reviewRoundsMedian)],
    ["spend", "Spend", usdText(h.covered.usd)],
  ];
}

function FigureTable({ health }: { health: ScorecardFactoryHealth }): ReactNode {
  return (
    <Table density="dense">
      <TableBody>
        {figures(health).map(([id, label, value, inferred]) => (
          <TableRow key={id} testID={`scorecard-health-${id}`}>
            <TableCell>{label}</TableCell>
            <TableCell align="right">{inferred === true ? <Labelled value={value} origin={INFERRED_FILER} /> : value}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function TierTable({ tiers }: { tiers: ScorecardFactoryHealth["modelTiers"] }): ReactNode {
  if (tiers.length === 0) return <EmptyState title="No dispatch this week" />;
  return (
    <Table density="dense" contentMinWidth={TIER_MIN_WIDTH}>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Model</TableHeaderCell>
          <TableHeaderCell align="right">Dispatched</TableHeaderCell>
          <TableHeaderCell align="right">Merged</TableHeaderCell>
          <TableHeaderCell align="right">Fix rounds</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tiers.map((tier) => (
          <TableRow key={tier.model} testID={`scorecard-tier-${tier.model}`}>
            <TableCell>{tier.model}</TableCell>
            <TableCell align="right">{String(tier.dispatched)}</TableCell>
            <TableCell align="right">{shareText(tier.mergeRate)}</TableCell>
            <TableCell align="right">{numberText(tier.fixRoundsMean)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function WakeTable({ wakes }: { wakes: ScorecardFactoryHealth["wakes"] }): ReactNode {
  if (wakes === null) return <EmptyState title="Not measured: the session graph's turns carry no wake cause" />;
  if (wakes.length === 0) return <EmptyState title="No seat woke this week" />;
  return (
    <Table density="dense" contentMinWidth={WAKE_MIN_WIDTH}>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Seat</TableHeaderCell>
          <TableHeaderCell align="right">Timer</TableHeaderCell>
          <TableHeaderCell align="right">Event</TableHeaderCell>
          <TableHeaderCell align="right">Typed</TableHeaderCell>
          <TableHeaderCell align="right">Timer, no action</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {wakes.map((seat) => (
          <TableRow key={seat.seat} testID={`scorecard-wakes-${seat.seat}`}>
            <TableCell>{seat.seat}</TableCell>
            <TableCell align="right">{String(seat.timer)}</TableCell>
            <TableCell align="right">{String(seat.event)}</TableCell>
            <TableCell align="right">{String(seat.typed)}</TableCell>
            <TableCell align="right">{NOT_MEASURED}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Yegge's measurement items (TP-5446 plan, section 11), as the job stored them; a figure with no source yet says so. */
export function FactoryHealthSection({ week }: { week: ScorecardWeek }): ReactNode {
  const health = week.factoryHealth;
  return (
    <Section testID="scorecard-factory-health">
      <SectionHeader title="Factory health" subtitle="Self-generated work, fences, model tiers and wakes" />
      <SectionContent>
        {health === null ? (
          <EmptyState title="Not measured: this week was scored before the factory health group" />
        ) : (
          <VStack gap={4}>
            <FigureTable health={health} />
            <TierTable tiers={health.modelTiers} />
            <WakeTable wakes={health.wakes} />
          </VStack>
        )}
      </SectionContent>
    </Section>
  );
}
