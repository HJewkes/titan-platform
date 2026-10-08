import type { ReactNode } from "react";
import {
  Alert,
  DateTime,
  HStack,
  Link,
  PortfolioOverview,
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
  type InitiativeCardProps,
  type PortfolioOverviewSection,
  type PortfolioOverviewStat,
} from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";
import { PersonalBadge } from "./PersonalBadge.js";

type Row = ConsoleCommands["work.portfolio"]["result"]["initiatives"][number];

const STATE_SECTIONS = [
  ["focused", "Focused · by rank"],
  ["backburner", "Backburner"],
  ["paused", "Paused"],
  ["done", "Done"],
] as const;

const COUNT_WIDTH = 96;

function cardOf(row: Row): InitiativeCardProps {
  return { title: row.title, slug: row.slug, state: row.state, rank: row.rank, shipTarget: row.shipTarget, openCount: row.openTasks, severityCounts: row.severityCounts, topTask: row.topTask };
}

function sectionsOf(rows: readonly Row[]): PortfolioOverviewSection[] {
  return STATE_SECTIONS.map(([state, heading]) => ({ heading, items: rows.filter((row) => row.state === state).map(cardOf) })).filter((section) => section.items.length > 0);
}

function statsOf(rows: readonly Row[]): PortfolioOverviewStat[] {
  const openTasks = rows.reduce((sum, row) => sum + row.openTasks, 0);
  return [
    { value: String(rows.filter((row) => row.state === "focused").length), label: "Focused" },
    { value: String(openTasks), label: "Open tasks" },
    { value: String(rows.length), label: "Initiatives" },
    { value: String(rows.filter((row) => row.personal).length), label: "Personal" },
  ];
}

/** The initiative portfolio: react-ui's overview, then each initiative's record counts with a way into its detail. */
export function InitiativesPage(): ReactNode {
  const portfolio = useQuery("work.portfolio");
  if (portfolio.status === "loading") return <Spinner size="sm" label="Loading initiatives" />;
  if (portfolio.data === undefined) return <Alert status="error" message={`Could not load initiatives: ${portfolio.error?.message ?? "no answer"}`} />;
  const { initiatives, personalKnown, parseErrors } = portfolio.data;
  return (
    <VStack gap={6}>
      {personalKnown ? null : <Alert status="warning" message="active-work could not say which initiatives are personal, so every one is treated as personal and left out of exports." />}
      {parseErrors.length > 0 ? <Alert status="warning" message={`Unreadable briefs: ${parseErrors.map((entry) => entry.slug).join(", ")}`} /> : null}
      <PortfolioOverview title="Initiatives" subtitle="Read from the active-work daemon" stats={statsOf(initiatives)} sections={sectionsOf(initiatives)} />
      <Section>
        <SectionHeader title="Records" subtitle="Open tasks, notes, sources and sessions per initiative" />
        <SectionContent>
          <RecordsTable rows={initiatives} />
        </SectionContent>
      </Section>
    </VStack>
  );
}

function RecordsTable({ rows }: { rows: readonly Row[] }): ReactNode {
  return (
    <Table density="dense">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Initiative</TableHeaderCell>
          {["Open tasks", "Notes", "Sources", "Sessions"].map((label) => (
            <TableHeaderCell key={label} width={COUNT_WIDTH} align="right">
              {label}
            </TableHeaderCell>
          ))}
          <TableHeaderCell width={160}>Newest activity</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <RecordsRow key={row.slug} row={row} />
        ))}
      </TableBody>
    </Table>
  );
}

function RecordsRow({ row }: { row: Row }): ReactNode {
  return (
    <TableRow testID={`initiative-row-${row.slug}`}>
      <TableCell>
        <HStack gap={2} align="center">
          <Link color="primary" onPress={() => open({ view: "initiatives", id: row.slug })}>
            {row.slug}
          </Link>
          {row.personal ? <PersonalBadge /> : null}
        </HStack>
      </TableCell>
      {[row.openTasks, row.notes, row.sources, row.sessions].map((count, column) => (
        <TableCell key={column} width={COUNT_WIDTH} align="right">
          {String(count)}
        </TableCell>
      ))}
      <TableCell width={160}>
        <DateTime value={row.newestActivity} format="datetime" variant="caption" color="secondary" fallback="none" />
      </TableCell>
    </TableRow>
  );
}
