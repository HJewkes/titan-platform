import { useState, type ReactNode } from "react";
import {
  Caption,
  DataRow,
  EmptyState,
  Metric,
  MetricGroup,
  Progress,
  Section,
  SectionContent,
  SectionHeader,
  Tab,
  TabList,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Tabs,
  VStack,
} from "@titan-design/react-ui";
import type { ArRunView } from "../../server/autoresearch-view.js";
import { shortId, signed } from "./autoresearch-format.js";
import { runProgress, type RunProgress } from "./autoresearch-progress.js";
import { scoreboard, STOP_RUNGS, type Ranked, type Scoreboard } from "./autoresearch-scoreboard.js";
import { AutoresearchProgressChart, AutoresearchSpendChart, type ProgressAxis } from "./AutoresearchProgressChart.js";
import { formatCost } from "./SessionFormat.js";
import { PHONE_TAP } from "./phone-tap.js";

const AXES: readonly { axis: ProgressAxis; label: string }[] = [
  { axis: "time", label: "Wall time" },
  { axis: "ideas", label: "Ideas evaluated" },
];

const PERCENT = 100;

/** Below this the cell table scrolls sideways rather than overlap a long cell name with its trial count. */
const CELLS_MIN_WIDTH = 560;

/** Design §1.5: the scoreboard, wins and losses, the progress chart and the planner's per-cell table. */
export function AutoresearchProgress({ run }: { run: ArRunView }): ReactNode {
  const board = scoreboard(run);
  return (
    <Section testID="autoresearch-progress">
      <SectionHeader title="Wins and losses" subtitle="Every decided idea, and how the best primary moved" />
      <SectionContent>
        <VStack gap={4}>
          <ScoreboardRow board={board} />
          <StopsByRung board={board} />
          <RankedList testID="autoresearch-wins" title="Wins" rows={board.wins} empty="No idea has been kept yet" />
          <RankedList testID="autoresearch-losses" title="Losses past L1" rows={board.losses} empty="No idea has been rejected past L1" />
          <ProgressPanel run={run} />
          <CellTable cells={run.cells} />
        </VStack>
      </SectionContent>
    </Section>
  );
}

function ScoreboardRow({ board }: { board: Scoreboard }): ReactNode {
  return (
    <VStack gap={2} testID="autoresearch-scoreboard">
      <MetricGroup>
        <Metric size="sm" label="Kept" value={String(board.kept)} />
        <Metric size="sm" label="Rejected" value={String(board.rejected)} />
        <Metric size="sm" label="Stopped" value={String(board.stopped)} />
        <Metric size="sm" label="Superseded" value={String(board.superseded)} />
      </MetricGroup>
      <MetricGroup>
        <Metric size="sm" label="Keep rate" value={board.keepRate === undefined ? "—" : `${Math.round(board.keepRate * PERCENT)}%`} />
        <Metric size="sm" label="$ per kept" value={board.usdPerKept === undefined ? "—" : formatCost(board.usdPerKept)} />
        <Metric size="sm" label="Wasted $" value={formatCost(board.wastedUsd)} />
      </MetricGroup>
    </VStack>
  );
}

/** BarList stands in as Progress rows until react-ui exports one. */
function StopsByRung({ board }: { board: Scoreboard }): ReactNode {
  const most = Math.max(1, ...STOP_RUNGS.map((rung) => board.stopsByRung[rung]));
  return (
    <VStack gap={1} testID="autoresearch-stops">
      <Caption>Rejected or stopped, by the rung reached</Caption>
      {STOP_RUNGS.map((rung) => (
        <DataRow key={rung} label={`${rung} · ${board.stopsByRung[rung]}`} value={<Progress size="sm" value={board.stopsByRung[rung]} max={most} trackWidth={160} />} />
      ))}
    </VStack>
  );
}

function RankedList({ testID, title, rows, empty }: { testID: string; title: string; rows: readonly Ranked[]; empty: string }): ReactNode {
  const most = Math.max(1, ...rows.map((row) => Math.abs(row.deltaOverSigma)));
  return (
    <VStack gap={1} testID={testID}>
      <Caption>{`${title}, by |Δ/σ|`}</Caption>
      {rows.length === 0 ? (
        <Caption>{empty}</Caption>
      ) : (
        rows.map((row) => (
          <DataRow
            key={row.id}
            label={`${shortId(row.id)} · ${row.cell}`}
            value={<Progress size="sm" value={Math.abs(row.deltaOverSigma)} max={most} trackWidth={120} showValue formatValue={() => `${signed(row.deltaOverSigma)}σ`} />}
          />
        ))
      )}
    </VStack>
  );
}

function ProgressPanel({ run }: { run: ArRunView }): ReactNode {
  const [tab, setTab] = useState(0);
  const progress = runProgress(run);
  const { primary, direction } = run.target.metric;
  return (
    <VStack gap={2}>
      <Tabs index={tab} onChange={setTab}>
        <TabList>
          {AXES.map(({ label }) => (
            <Tab key={label} className={PHONE_TAP}>{label}</Tab>
          ))}
        </TabList>
      </Tabs>
      <Caption testID="autoresearch-progress-summary">{progressSummary(run, progress)}</Caption>
      <AutoresearchProgressChart progress={progress} axis={AXES[tab]!.axis} primary={primary} direction={direction} />
      <Caption>Cumulative spend</Caption>
      <AutoresearchSpendChart points={progress.points} />
    </VStack>
  );
}

/** The band's state in words: the chart interim cannot label its lock rule, and a reader should not have to infer it. */
function progressSummary(run: ArRunView, progress: RunProgress): string {
  const last = progress.samples.at(-1)!;
  const { primary, noise } = run.target.metric;
  const sigmaState =
    progress.lockedAt === undefined
      ? `σ unlocked: the default band until ${noise.lockAfterPairs} pairs`
      : `σ locked from idea ${progress.lockedAt.order}`;
  return `Best ${primary} ${last.best} after ${progress.points.length} decided · band ±${last.band.halfWidth.toFixed(2)} · ${sigmaState}`;
}

function CellTable({ cells }: { cells: ArRunView["cells"] }): ReactNode {
  if (cells.length === 0) return <EmptyState title="The planner digest has no cell yet" />;
  return (
    <Table density="dense" contentMinWidth={CELLS_MIN_WIDTH} testID="autoresearch-cells">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Cell</TableHeaderCell>
          <TableHeaderCell>Trials</TableHeaderCell>
          <TableHeaderCell>Mean |Δ|/σ</TableHeaderCell>
          <TableHeaderCell>Keep rate</TableHeaderCell>
          <TableHeaderCell>Flag</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cells.map((cell) => (
          <TableRow key={cell.cell} testID={`autoresearch-cell-${cell.cell}`}>
            <TableCell>{cell.cell}</TableCell>
            <TableCell>{cell.trials}</TableCell>
            <TableCell>{cell.meanAbsDeltaOverSigma.toFixed(1)}</TableCell>
            <TableCell>{`${Math.round(cell.keepRate * PERCENT)}%`}</TableCell>
            <TableCell>{cell.flag ?? "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
