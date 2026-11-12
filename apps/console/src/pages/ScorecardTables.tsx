import type { ReactNode } from "react";
import { Badge, BadgeText, EmptyState, HStack, Section, SectionContent, SectionHeader, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Typography } from "@titan-design/react-ui";
import type { ScorecardCell, ScorecardWeek } from "../../server/scorecard-schema.js";
import { allCell, flagText, hoursText, NOT_MEASURED, numberText, shareText, usdText } from "./scorecard-format.js";

/** Below these widths a table scrolls inside its own box, so a phone never scrolls the page sideways. */
const BREAKDOWN_MIN_WIDTH = 640;
const PHASE_MIN_WIDTH = 360;

type Metrics = ScorecardCell["metrics"];

/** Every weekly figure past the headline. WIP age (TP-867) has no column in the store yet, so it reads as not measured. */
const FIGURES: readonly [string, (m: Metrics) => string][] = [
  ["Product share", (m) => shareText(m.productShare)],
  ["Picked within a day of filing", (m) => shareText(m.sameDayShare)],
  ["Median age at dispatch", (m) => hoursText(m.ageMedianH)],
  ["Simple-rule agreement (top K)", (m) => shareText(m.ruleAgreement)],
  ["Median rule percentile of picks", (m) => numberText(m.ruleRankPctMedian)],
  ["Tasks with 3+ fix rounds", (m) => shareText(m.fixRounds3PlusShare)],
  ["Median review rounds", (m) => numberText(m.reviewRoundsMedian)],
  ["Reverts", (m) => String(m.reverts)],
  ["Follow-ups per merged task", (m) => numberText(m.followupsPerMerged)],
  ["Spend", (m) => usdText(m.usd)],
  ["Unmerged spend", (m) => usdText(m.unmergedUsd)],
  ["Owner-gated share", (m) => shareText(m.ownerGatedShare)],
  ["Owner-gate hours", (m) => numberText(m.ownerGateHours)],
  ["WIP age", () => NOT_MEASURED],
  ["Rows resting on inferred labels", (m) => shareText(m.inferredShare)],
];

export function WeekFigures({ week }: { week: ScorecardWeek }): ReactNode {
  const cell = allCell(week);
  if (cell === undefined) return null;
  return (
    <Section testID="scorecard-figures">
      <SectionHeader title="Week figures" subtitle="Selection, outcome and cost" />
      <SectionContent>
        <Table density="dense">
          <TableBody>
            {FIGURES.map(([label, value]) => (
              <TableRow key={label}>
                <TableCell>{label}</TableCell>
                <TableCell align="right">{value(cell.metrics)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionContent>
    </Section>
  );
}

interface BreakdownProps {
  week: ScorecardWeek;
  dimension: string;
  title: string;
  empty: string;
}

export function BreakdownSection({ week, dimension, title, empty }: BreakdownProps): ReactNode {
  const cells = week.cells.filter((cell) => cell.dimension === dimension);
  return (
    <Section testID={`scorecard-${dimension}`}>
      <SectionHeader title={title} subtitle={`Dispatched in ${week.isoWeek}`} />
      <SectionContent>{cells.length === 0 ? <EmptyState title={empty} /> : <BreakdownTable cells={cells} />}</SectionContent>
    </Section>
  );
}

function BreakdownTable({ cells }: { cells: readonly ScorecardCell[] }): ReactNode {
  return (
    <Table density="dense" contentMinWidth={BREAKDOWN_MIN_WIDTH}>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Name</TableHeaderCell>
          <TableHeaderCell align="right">Dispatched</TableHeaderCell>
          <TableHeaderCell align="right">Merged</TableHeaderCell>
          <TableHeaderCell align="right">Upkeep</TableHeaderCell>
          <TableHeaderCell align="right">Owner</TableHeaderCell>
          <TableHeaderCell align="right">Per merge</TableHeaderCell>
          <TableHeaderCell>Flags</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cells.map((cell) => (
          <BreakdownRow key={cell.key} cell={cell} />
        ))}
      </TableBody>
    </Table>
  );
}

function BreakdownRow({ cell }: { cell: ScorecardCell }): ReactNode {
  return (
    <TableRow testID={`scorecard-row-${cell.dimension}-${cell.key}`}>
      <TableCell>{cell.key}</TableCell>
      <TableCell align="right">{String(cell.metrics.dispatched)}</TableCell>
      <TableCell align="right">{String(cell.metrics.merged)}</TableCell>
      <TableCell align="right">{shareText(cell.metrics.upkeepShare)}</TableCell>
      <TableCell align="right">{shareText(cell.metrics.ownerSourcedShare)}</TableCell>
      <TableCell align="right">{usdText(cell.metrics.costPerMerged)}</TableCell>
      <TableCell>
        <CellFlags flags={cell.redFlags} />
      </TableCell>
    </TableRow>
  );
}

function CellFlags({ flags }: { flags: readonly string[] }): ReactNode {
  if (flags.length === 0) return <Typography variant="caption" color="secondary">none</Typography>;
  return (
    <HStack gap={1} wrap>
      {flags.map((flag) => (
        <Badge key={flag} color="error" variant="subtle" size="sm">
          <BadgeText>{flagText(flag)}</BadgeText>
        </Badge>
      ))}
    </HStack>
  );
}

/** Shepherd's minutes per stage over every repo (TP-467); a run counts in the week it finished. */
export function PhaseSection({ week }: { week: ScorecardWeek }): ReactNode {
  const phases = week.phases.filter((phase) => phase.repo === "all");
  return (
    <Section testID="scorecard-phases">
      <SectionHeader title="Shepherd phases" subtitle="Minutes per stage, runs finished this week" />
      <SectionContent>{phases.length === 0 ? <EmptyState title="Not measured: no Shepherd run finished this week" /> : <PhaseTable phases={phases} />}</SectionContent>
    </Section>
  );
}

function PhaseTable({ phases }: { phases: ScorecardWeek["phases"] }): ReactNode {
  return (
    <Table density="dense" contentMinWidth={PHASE_MIN_WIDTH}>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Stage</TableHeaderCell>
          <TableHeaderCell align="right">Runs</TableHeaderCell>
          <TableHeaderCell align="right">Median</TableHeaderCell>
          <TableHeaderCell align="right">p90</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {phases.map((phase) => (
          <TableRow key={phase.stage}>
            <TableCell>{phase.stage}</TableCell>
            <TableCell align="right">{String(phase.runs)}</TableCell>
            <TableCell align="right">{String(phase.medianMinutes)}</TableCell>
            <TableCell align="right">{String(phase.p90Minutes)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
