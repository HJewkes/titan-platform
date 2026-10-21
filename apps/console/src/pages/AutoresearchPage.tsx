import type { ReactNode } from "react";
import {
  Alert,
  Badge,
  BadgeText,
  DataRow,
  DateTime,
  EmptyState,
  Link,
  Section,
  SectionContent,
  SectionHeader,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  VStack,
} from "@titan-design/react-ui";
import type { ArRunView } from "../../server/autoresearch-view.js";
import { AR_RUN_FIXTURE } from "../../server/twin/autoresearch.js";
import { open, type Route } from "../router.js";
import { formatCost } from "./SessionFormat.js";

const SHORT_SHA = 7;

/** Until the daemon reader lands (TP-3843) the page shows one synthetic run, and says so. */
const RUNS: readonly ArRunView[] = [AR_RUN_FIXTURE];

export function AutoresearchView({ route }: { route: Route }): ReactNode {
  const run = route.id === undefined ? undefined : RUNS.find((candidate) => candidate.runId === route.id);
  return (
    <VStack gap={6}>
      <Alert status="info" message="Preview: a synthetic run. Live runs arrive with the console's autoresearch reader (TP-3843)." />
      {route.id === undefined ? <RunsSection runs={RUNS} /> : run ? <RunHeader run={run} /> : <EmptyState title={`No autoresearch run ${route.id}`} />}
    </VStack>
  );
}

function RunsSection({ runs }: { runs: readonly ArRunView[] }): ReactNode {
  return (
    <Section>
      <SectionHeader title="Runs" subtitle="The live run first, then finished ones" />
      <SectionContent>
        <Table density="dense">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Run</TableHeaderCell>
              <TableHeaderCell>Target</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Round</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <RunRow key={run.runId} run={run} />
            ))}
          </TableBody>
        </Table>
      </SectionContent>
    </Section>
  );
}

function RunRow({ run }: { run: ArRunView }): ReactNode {
  return (
    <TableRow testID={`autoresearch-run-${run.runId}`}>
      <TableCell>
        <Link color="primary" onPress={() => open({ view: "autoresearch", id: run.runId })}>
          {run.runId}
        </Link>
      </TableCell>
      <TableCell>{run.target.name}</TableCell>
      <TableCell>
        <StatusBadge status={run.status} />
      </TableCell>
      <TableCell>{roundText(run)}</TableCell>
    </TableRow>
  );
}

/** §1.1 of the design: identity, status, progress and spend. Noise, caps and load wait wait on engine fields (G4, G7, G9). */
function RunHeader({ run }: { run: ArRunView }): ReactNode {
  const { primary } = run.target.metric;
  return (
    <Section testID="autoresearch-header">
      <SectionHeader title={`${run.target.name} · ${run.runId}`} subtitle={`Phase ${run.target.phases[0]}`} />
      <SectionContent>
        <DataRow label="Status" value={<StatusBadge status={run.status} />} />
        <DataRow label="Started" value={<DateTime value={run.startedAt} format="datetime" />} />
        <DataRow label="Round" value={roundText(run)} />
        <DataRow label={`Best ${primary}`} value={bestText(run)} />
        <DataRow label="Decisions" value={decisionsText(run)} />
        <DataRow label="Lanes in use" value={`${liveLadders(run)} / ${run.settings.lanes}`} />
        <DataRow label="Spend" value={formatCost(spendUsd(run))} />
        <DataRow label="Pin" value={run.target.pin.slice(0, SHORT_SHA)} />
        <DataRow label="Ratchet" value={`${run.target.ratchetRef} at ${run.best.head.slice(0, SHORT_SHA)}`} />
      </SectionContent>
    </Section>
  );
}

function StatusBadge({ status }: { status: ArRunView["status"] }): ReactNode {
  const color = status === "running" ? "info" : status === "completed" ? "success" : status === "failed" ? "error" : "warning";
  return (
    <Badge color={color} variant="subtle" size="sm">
      <BadgeText>{status}</BadgeText>
    </Badge>
  );
}

const ladders = (run: ArRunView) => run.rounds.flatMap((round) => round.ladders);

const roundText = (run: ArRunView): string => `${run.rounds.at(-1)?.round ?? 0} / ${run.settings.rounds}`;

const liveLadders = (run: ArRunView): number => ladders(run).filter((ladder) => ladder.active !== null).length;

/** Δ is signed so that positive is better, whichever way the target's metric points. */
function bestText(run: ArRunView): string {
  const { direction } = run.target.metric;
  const gain = direction === "min" ? run.baseline.b0 - run.best.primary : run.best.primary - run.baseline.b0;
  const sign = gain >= 0 ? "+" : "−";
  return `${run.best.primary} (${sign}${Math.abs(gain).toFixed(1)} vs B₀ ${run.baseline.b0})`;
}

/** A superseded winner counts apart from the other stops: it is back in the queue, not a loss. */
function decisionsText(run: ArRunView): string {
  const outcomes = ladders(run).flatMap((ladder) => (ladder.outcome ? [ladder.outcome] : []));
  const count = (test: (outcome: (typeof outcomes)[number]) => boolean) => outcomes.filter(test).length;
  const superseded = count((outcome) => outcome.reason === "superseded");
  const stopped = count((outcome) => outcome.verdict === "stopped") - superseded;
  return `kept ${count((outcome) => outcome.verdict === "kept")} · rejected ${count((outcome) => outcome.verdict === "rejected")} · stopped ${stopped} · superseded ${superseded}`;
}

function spendUsd(run: ArRunView): number {
  const evals = [...run.baseline.runs, ...ladders(run).flatMap((ladder) => ladder.evals)];
  const implement = ladders(run).reduce((sum, ladder) => sum + (ladder.implementUsd ?? 0), 0);
  return evals.reduce((sum, entry) => sum + entry.usd, implement);
}
