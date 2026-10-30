import { useState, type ReactNode } from "react";
import { Alert, Badge, BadgeText, EmptyState, HStack, Section, SectionContent, SectionHeader, Spinner, Tab, TabList, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Tabs, VStack } from "@titan-design/react-ui";
import { DEFAULT_LIMITS, budgetFor } from "../../server/perf/budgets.js";
import { useQuery, type ServedCommands } from "../data/rpc.js";
import { PHONE_TAP } from "./phone-tap.js";

/** Plan §2: no page waits longer than this for its first data. */
const ROUTE_BUDGET_MS = 3000;

function routeOverBudget(row: { p95: number }): boolean {
  return row.p95 > ROUTE_BUDGET_MS;
}

function rpcOverBudget(row: { name: string; p95: number; bytesMax: number }): boolean {
  const budget = budgetFor(row.name) ?? DEFAULT_LIMITS;
  return row.p95 > budget.maxMs || row.bytesMax > budget.maxBytes;
}

type Summary = ServedCommands["perf.summary"]["result"];
const WINDOWS = ["15m", "24h"] as const;
/** The sort key stays on a phone; every other number waits for a wider screen. */
const KEPT_LABEL = "p95 ms";
const KEPT_INDEX = 1;
const HIDE_ON_PHONE = "max-md:hidden";

/** What the console measured about itself, slowest first; a row past its budget carries a warning badge. */
export function PerfTab(): ReactNode {
  const [index, setIndex] = useState(0);
  const summary = useQuery("perf.summary", { window: WINDOWS[index]! });
  return (
    <VStack gap={4}>
      <Tabs index={index} onChange={setIndex}>
        <TabList>
          <Tab className={PHONE_TAP}>15 min</Tab>
          <Tab className={PHONE_TAP}>24 h</Tab>
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
      <Block id="perf-routes" title="Routes" subtitle="Time to first data" empty="No route timed yet" count={summary.routes.length}>
        <RouteTable rows={summary.routes} />
      </Block>
      <Block id="perf-rpcs" title="RPCs" subtitle="Milliseconds and response bytes per command" empty="No call recorded" count={summary.rpcs.length}>
        <RpcTable rows={summary.rpcs} />
      </Block>
      <Block id="perf-upstreams" title="Upstreams" subtitle="Calls the console made to other daemons" empty="No upstream call recorded" count={summary.upstreams.length}>
        <UpstreamTable rows={summary.upstreams} />
      </Block>
    </>
  );
}

interface BlockProps {
  id: string;
  title: string;
  subtitle: string;
  empty: string;
  count: number;
  children: ReactNode;
}

function Block({ id, title, subtitle, empty, count, children }: BlockProps): ReactNode {
  return (
    <Section testID={id}>
      <SectionHeader title={title} subtitle={subtitle} />
      <SectionContent>{count === 0 ? <EmptyState title={empty} /> : children}</SectionContent>
    </Section>
  );
}

function OverBudget(): ReactNode {
  return (
    <Badge color="warning" variant="subtle" size="sm" testID="perf-over-budget" className="whitespace-nowrap">
      <BadgeText>over budget</BadgeText>
    </Badge>
  );
}

function PerfTable({ labels, children }: { labels: readonly string[]; children: ReactNode }): ReactNode {
  return (
    <Table density="dense">
      <TableHeader>
        <TableRow>
          {labels.map((label, i) => (
            <TableHeaderCell key={label} align={i === 0 ? "left" : "right"} className={i === 0 || label === KEPT_LABEL ? undefined : HIDE_ON_PHONE}>
              {label}
            </TableHeaderCell>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

function Num({ value, hideOnPhone }: { value: number; hideOnPhone: boolean }): ReactNode {
  return (
    <TableCell align="right" className={hideOnPhone ? HIDE_ON_PHONE : undefined}>
      {Math.round(value).toLocaleString("en-US")}
    </TableCell>
  );
}

/** `values` follow the labels after the name, and the one at {@link KEPT_INDEX} is p95. */
function Nums({ values }: { values: readonly number[] }): ReactNode {
  return (
    <>
      {values.map((value, i) => (
        <Num key={i} value={value} hideOnPhone={i !== KEPT_INDEX} />
      ))}
    </>
  );
}

function NameCell({ name, over }: { name: string; over: boolean }): ReactNode {
  return (
    <TableCell>
      <HStack gap={2} align="center">
        <span>{name}</span>
        {over ? <OverBudget /> : null}
      </HStack>
    </TableCell>
  );
}

function RouteTable({ rows }: { rows: Summary["routes"] }): ReactNode {
  return (
    <PerfTable labels={["Route", "p50 ms", "p95 ms", "Count"]}>
      {rows.map((row) => (
        <TableRow key={row.name} testID={`perf-route-${row.name}`}>
          <NameCell name={row.name} over={routeOverBudget(row)} />
          <Nums values={[row.p50, row.p95, row.count]} />
        </TableRow>
      ))}
    </PerfTable>
  );
}

function RpcTable({ rows }: { rows: Summary["rpcs"] }): ReactNode {
  return (
    <PerfTable labels={["Command", "p50 ms", "p95 ms", "p50 bytes", "Errors", "Count"]}>
      {rows.map((row) => (
        <TableRow key={row.name} testID={`perf-rpc-${row.name}`}>
          <NameCell name={row.name} over={rpcOverBudget(row)} />
          <Nums values={[row.p50, row.p95, row.bytesP50, row.errors, row.count]} />
        </TableRow>
      ))}
    </PerfTable>
  );
}

function UpstreamTable({ rows }: { rows: Summary["upstreams"] }): ReactNode {
  return (
    <PerfTable labels={["Upstream call", "p50 ms", "p95 ms", "Errors", "Timeouts", "Count"]}>
      {rows.map((row) => (
        <TableRow key={row.name} testID={`perf-upstream-${row.name}`}>
          <NameCell name={row.name} over={false} />
          <Nums values={[row.p50, row.p95, row.errors, row.timeouts, row.count]} />
        </TableRow>
      ))}
    </PerfTable>
  );
}
