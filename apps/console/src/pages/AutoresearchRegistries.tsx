import { useState, type ReactNode } from "react";
import {
  Caption,
  EmptyState,
  Link,
  Section,
  SectionContent,
  SectionHeader,
  SparkBars,
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
import type { ArRegistries, ArRunView } from "../../server/autoresearch-view.js";
import { href, open } from "../router.js";
import { shortId, signed } from "./autoresearch-format.js";
import { ideaRoute } from "./autoresearch-lanes.js";
import { bugRepeatRates, REGISTRY_TAIL, registryTails, type RoundRepeats } from "./autoresearch-registries.js";
import { PHONE_TAP, PHONE_TAP_ID_LINK } from "./phone.js";

const PERCENT = 100;

/** Below this the registry tables scroll sideways rather than squeeze a lesson into a sliver. */
const REGISTRY_MIN_WIDTH = 880;

/** Design §1.6: the dead-end and bug tails every brief gets, and how often an L0 failure repeats a known bug. */
export function AutoresearchRegistries({ run }: { run: ArRunView }): ReactNode {
  const [tab, setTab] = useState(0);
  const tails = registryTails(run.registries);
  return (
    <Section testID="autoresearch-registries">
      <SectionHeader title="Registries" subtitle={`The last ${REGISTRY_TAIL} rows of each, as every implementer brief carries them`} />
      <SectionContent>
        <VStack gap={2}>
          <Tabs index={tab} onChange={setTab}>
            <TabList>
              <Tab className={PHONE_TAP}>{`Dead ends ${tails.deadEnds.length}`}</Tab>
              <Tab className={PHONE_TAP}>{`Bugs ${tails.bugs.length}`}</Tab>
              <Tab className={PHONE_TAP}>Bug-repeat rate</Tab>
            </TabList>
          </Tabs>
          {tab === 0 ? <DeadEnds runId={run.runId} rows={tails.deadEnds} /> : tab === 1 ? <Bugs runId={run.runId} rows={tails.bugs} /> : <RepeatRate rounds={bugRepeatRates(run)} />}
        </VStack>
      </SectionContent>
    </Section>
  );
}

/** One column: its header label and the cell it draws for a row. Header and body both read this list, so they cannot drift. */
interface Column<Row> {
  label: string;
  cell: (row: Row) => ReactNode;
}

type ProducedRow = { ideaId?: string; round?: number };

/**
 * TP-3867: the idea that produced the row, linked to its drawer, and its round. A planner analysis bug names no idea, and a
 * row recorded before the engine kept either shows a dash.
 */
function producedByColumns<Row extends ProducedRow>(runId: string): Column<Row>[] {
  return [
    { label: "Idea", cell: (row) => (row.ideaId === undefined ? "—" : <IdeaLink runId={runId} ideaId={row.ideaId} />) },
    { label: "Round", cell: (row) => (row.round === undefined ? "—" : `r${row.round}`) },
  ];
}

function deadEndColumns(runId: string): Column<ArRegistries["deadEnds"][number]>[] {
  return [
    ...producedByColumns(runId),
    { label: "Cell", cell: (row) => row.cell },
    { label: "Targets", cell: (row) => row.targets.join(", ") || "—" },
    { label: "Rung failed", cell: (row) => row.rungFailed },
    { label: "Δ/σ", cell: (row) => (row.deltaOverSigma === undefined ? "—" : `${signed(row.deltaOverSigma)}σ`) },
    { label: "Lesson", cell: (row) => row.lesson ?? "—" },
  ];
}

function bugColumns(runId: string): Column<ArRegistries["bugs"][number]>[] {
  return [
    ...producedByColumns(runId),
    { label: "Symptom", cell: (row) => row.symptom },
    { label: "Fix", cell: (row) => row.fix || "—" },
    { label: "Source", cell: (row) => row.source },
  ];
}

function RegistryTable<Row>({ columns, rows, testID }: { columns: Column<Row>[]; rows: readonly Row[]; testID: string }): ReactNode {
  return (
    <Table density="dense" contentMinWidth={REGISTRY_MIN_WIDTH} testID={testID}>
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
            <TableHeaderCell key={column.label}>{column.label}</TableHeaderCell>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={index}>
            {columns.map((column) => (
              <TableCell key={column.label}>{column.cell(row)}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DeadEnds({ runId, rows }: { runId: string; rows: ArRegistries["deadEnds"] }): ReactNode {
  if (rows.length === 0) return <EmptyState title="No idea has failed past L0 yet" />;
  return <RegistryTable columns={deadEndColumns(runId)} rows={rows} testID="autoresearch-dead-ends" />;
}

function Bugs({ runId, rows }: { runId: string; rows: ArRegistries["bugs"] }): ReactNode {
  if (rows.length === 0) return <EmptyState title="No L0 failure or planner analysis has logged a bug yet" />;
  return <RegistryTable columns={bugColumns(runId)} rows={rows} testID="autoresearch-bugs" />;
}

function IdeaLink({ runId, ideaId }: { runId: string; ideaId: string }): ReactNode {
  const target = ideaRoute(runId, ideaId);
  return (
    <Link color="primary" className={PHONE_TAP_ID_LINK} href={href(target)} onPress={() => open(target)} testID={`autoresearch-registry-idea-${ideaId}`}>
      {shortId(ideaId)}
    </Link>
  );
}

const repeatText = ({ round, failures, repeats, rate }: RoundRepeats): string =>
  rate === undefined ? `r${round} no L0 failure` : `r${round} ${repeats}/${failures} (${Math.round(rate * PERCENT)}%)`;

/** A round with no L0 failure draws as an empty bar and says so, rather than plot as a 0% repeat rate. */
function RepeatRate({ rounds }: { rounds: readonly RoundRepeats[] }): ReactNode {
  if (rounds.length === 0) return <EmptyState title="No round has run yet" />;
  return (
    <VStack gap={1} testID="autoresearch-repeat-rate">
      <Caption>The share of each round's L0 failures whose reason code an earlier round had already logged</Caption>
      <SparkBars values={rounds.map((entry) => (entry.rate ?? 0) * PERCENT)} height={32} barWidth={8} label="Bug-repeat rate per round" />
      <Caption>{rounds.map(repeatText).join(" · ")}</Caption>
    </VStack>
  );
}
