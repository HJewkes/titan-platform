import type { ReactNode } from "react";
import {
  Alert,
  EmptyState,
  Link,
  Section,
  SectionContent,
  SectionHeader,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  VStack,
} from "@titan-design/react-ui";
import type { ArRunSummary } from "../../server/autoresearch-view.js";
import { useQuery } from "../data/rpc.js";
import { open, type Route } from "../router.js";
import { AutoresearchBacklog } from "./AutoresearchBacklog.js";
import { AutoresearchDecisions } from "./AutoresearchDecisions.js";
import { AutoresearchHeader, RunStatusBadge } from "./AutoresearchHeader.js";

export function AutoresearchView({ route }: { route: Route }): ReactNode {
  return route.id === undefined ? <RunsSection /> : <RunSection runId={route.id} />;
}

/** A factory that is down or refuses shows its error, never an empty list that would read as "no runs". */
function RunsSection(): ReactNode {
  const runs = useQuery("autoresearch.runs", {});
  return (
    <Section>
      <SectionHeader title="Runs" subtitle="The live run first, then finished ones" />
      <SectionContent>
        {runs.status === "loading" ? (
          <Spinner size="sm" label="Loading the runs" />
        ) : runs.data === undefined ? (
          <Alert status="error" message={`Could not load the autoresearch runs: ${runs.error.message}`} />
        ) : runs.data.length === 0 ? (
          <EmptyState title="The factory holds no autoresearch run" />
        ) : (
          <RunsTable runs={runs.data} />
        )}
      </SectionContent>
    </Section>
  );
}

function RunsTable({ runs }: { runs: readonly ArRunSummary[] }): ReactNode {
  return (
    <Table density="dense">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Run</TableHeaderCell>
          <TableHeaderCell>Target</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Phase</TableHeaderCell>
          <TableHeaderCell>Round</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <RunRow key={run.runId} run={run} />
        ))}
      </TableBody>
    </Table>
  );
}

function RunRow({ run }: { run: ArRunSummary }): ReactNode {
  return (
    <TableRow testID={`autoresearch-run-${run.runId}`}>
      <TableCell>
        <Link color="primary" onPress={() => open({ view: "autoresearch", id: run.runId })}>
          {run.runId}
        </Link>
      </TableCell>
      <TableCell>{run.target}</TableCell>
      <TableCell>
        <RunStatusBadge status={run.status} />
      </TableCell>
      <TableCell>{run.phase}</TableCell>
      <TableCell>{`${run.round} / ${run.rounds}`}</TableCell>
    </TableRow>
  );
}

function RunSection({ runId }: { runId: string }): ReactNode {
  const run = useQuery("autoresearch.run", { runId });
  if (run.status === "loading") return <Spinner size="sm" label={`Loading ${runId}`} />;
  if (run.data === undefined) return <Alert status="error" message={`Could not load autoresearch run ${runId}: ${run.error.message}`} />;
  return (
    <VStack gap={4}>
      <AutoresearchHeader run={run.data} />
      <AutoresearchBacklog run={run.data} />
      <AutoresearchDecisions run={run.data} />
    </VStack>
  );
}
