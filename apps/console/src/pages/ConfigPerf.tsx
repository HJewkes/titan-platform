import { useState, type ReactNode } from "react";
import { Alert, Badge, BadgeText, EmptyState, Section, SectionContent, SectionHeader, Spinner, Tab, TabList, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Tabs, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { routeOverBudget, rpcOverBudget } from "../data/perf-budgets.js";
import { useQuery } from "../data/rpc.js";

type Summary = ConsoleCommands["perf.summary"]["result"];
const WINDOWS = ["15m", "24h"] as const;

/** What the console measured about itself, slowest first; a row past its budget carries a warning badge. */
export function PerfTab(): ReactNode {
  const [index, setIndex] = useState(0);
  const summary = useQuery("perf.summary", { window: WINDOWS[index]! });
  return (
    <VStack gap={4}>
      <Tabs index={index} onChange={setIndex}>
        <TabList>
          <Tab>15 min</Tab>
          <Tab>24 h</Tab>
        </TabList>
      </Tabs>
      {summary.status === "loading" ? (
        <Spinner size="sm" label="Loading timings" />
      ) : summary.data === undefined ? (
        <Alert status="error" message={`Could not load timings: ${summary.error.message}`} />
      ) : (
        <SummaryTables summary={summary.data} />
      )}
    </VStack>
  );
}

function SummaryTables({ summary }: { summary: Summary }): ReactNode {
  return (
    <>
      <Section testID="perf-routes">
        <SectionHeader title="Routes" subtitle="Time to first data" />
        <SectionContent>{summary.routes.length === 0 ? <EmptyState title="No route timed yet" /> : <RouteTable rows={summary.routes} />}</SectionContent>
      </Section>
      <Section testID="perf-rpcs">
        <SectionHeader title="RPCs" subtitle="Milliseconds and response bytes per command" />
        <SectionContent>{summary.rpcs.length === 0 ? <EmptyState title="No call recorded" /> : <RpcTable rows={summary.rpcs} />}</SectionContent>
      </Section>
      <Section testID="perf-upstreams">
        <SectionHeader title="Upstreams" subtitle="Calls the console made to other daemons" />
        <SectionContent>{summary.upstreams.length === 0 ? <EmptyState title="No upstream call recorded" /> : <UpstreamTable rows={summary.upstreams} />}</SectionContent>
      </Section>
    </>
  );
}

function OverBudget(): ReactNode {
  return (
    <Badge color="warning" variant="subtle" size="sm" testID="perf-over-budget">
      <BadgeText>over budget</BadgeText>
    </Badge>
  );
}

function Head({ labels }: { labels: readonly string[] }): ReactNode {
  return (
    <TableHeader>
      <TableRow>
        {labels.map((label, i) => (
          <TableHeaderCell key={label} align={i === 0 ? "left" : "right"}>
            {label}
          </TableHeaderCell>
        ))}
      </TableRow>
    </TableHeader>
  );
}

function Num({ value }: { value: number }): ReactNode {
  return <TableCell align="right">{Math.round(value).toLocaleString("en-US")}</TableCell>;
}

function RouteTable({ rows }: { rows: Summary["routes"] }): ReactNode {
  return (
    <Table density="dense">
      <Head labels={["Route", "p50 ms", "p95 ms", "Count"]} />
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.name} testID={`perf-route-${row.name}`}>
            <TableCell>
              {row.name} {routeOverBudget(row) ? <OverBudget /> : null}
            </TableCell>
            <Num value={row.p50} />
            <Num value={row.p95} />
            <Num value={row.count} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RpcTable({ rows }: { rows: Summary["rpcs"] }): ReactNode {
  return (
    <Table density="dense">
      <Head labels={["Command", "p50 ms", "p95 ms", "p50 bytes", "Errors", "Count"]} />
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.name} testID={`perf-rpc-${row.name}`}>
            <TableCell>
              {row.name} {rpcOverBudget(row) ? <OverBudget /> : null}
            </TableCell>
            <Num value={row.p50} />
            <Num value={row.p95} />
            <Num value={row.bytesP50} />
            <Num value={row.errors} />
            <Num value={row.count} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function UpstreamTable({ rows }: { rows: Summary["upstreams"] }): ReactNode {
  return (
    <Table density="dense">
      <Head labels={["Upstream call", "p50 ms", "p95 ms", "Errors", "Timeouts", "Count"]} />
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.name} testID={`perf-upstream-${row.name}`}>
            <TableCell>{row.name}</TableCell>
            <Num value={row.p50} />
            <Num value={row.p95} />
            <Num value={row.errors} />
            <Num value={row.timeouts} />
            <Num value={row.count} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
