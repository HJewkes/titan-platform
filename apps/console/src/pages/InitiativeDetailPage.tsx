import type { ReactNode } from "react";
import {
  Alert,
  BreadcrumbItem,
  Breadcrumbs,
  Card,
  CardContent,
  DateTime,
  HStack,
  InitiativeBrief,
  InitiativeHeader,
  OpenLoops,
  Pill,
  SessionList,
  Spinner,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Tabs,
  TaskTable,
  Typography,
  VStack,
  sessionLinkers,
} from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";
import { PersonalBadge } from "./PersonalBadge.js";

type Detail = ConsoleCommands["work.initiative"]["result"];

const LINKERS = sessionLinkers();

/** One initiative, composed the way react-ui's initiative reader story composes it, plus its notes and sources. */
export function InitiativeDetailPage({ slug }: { slug: string }): ReactNode {
  const detail = useQuery("work.initiative", { slug });
  if (detail.status === "loading") return <Spinner size="sm" label="Loading initiative" />;
  if (detail.data === undefined) {
    return (
      <VStack gap={4}>
        <Trail slug={slug} />
        <Alert status="error" message={`Could not load ${slug}: ${detail.error?.message ?? "no answer"}`} />
      </VStack>
    );
  }
  const { initiative, brief, loops, fetchedAt } = detail.data;
  const now = Date.parse(fetchedAt);
  return (
    <VStack gap={4}>
      <Trail slug={slug} />
      <HStack gap={3} align="center" wrap>
        <InitiativeHeader title={initiative.title} slug={initiative.slug} state={initiative.state} rank={initiative.rank} shipTarget={initiative.shipTarget} updated={initiative.updated} />
        {initiative.personal ? <PersonalBadge /> : null}
      </HStack>
      <Panel>
        <OpenLoops loops={loops} now={now} linkers={LINKERS} emptyLabel="No open loops" />
      </Panel>
      <Panel>
        <InitiativeBrief brief={{ ...initiative, body: brief.body }} linkers={LINKERS} />
        {brief.truncated ? <Alert status="info" size="compact" message="The brief is longer than active-work's read cap; this is its head." /> : null}
      </Panel>
      <Panel>
        <Records detail={detail.data} now={now} />
      </Panel>
    </VStack>
  );
}

function Trail({ slug }: { slug: string }): ReactNode {
  return (
    <Breadcrumbs>
      <BreadcrumbItem onPress={() => open({ view: "initiatives" })}>Initiatives</BreadcrumbItem>
      <BreadcrumbItem isCurrentPage>{slug}</BreadcrumbItem>
    </Breadcrumbs>
  );
}

function Panel({ children }: { children: ReactNode }): ReactNode {
  return (
    <Card>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Records({ detail, now }: { detail: Detail; now: number }): ReactNode {
  const { tasks, sessions, notes, sources } = detail;
  const summaries = sessions.map((session) => ({ ...session, id: session.filename, body: "" }));
  return (
    <Tabs defaultIndex={0}>
      <TabList>
        <Tab>{`Tasks (${tasks.length})`}</Tab>
        <Tab>{`Sessions (${sessions.length})`}</Tab>
        <Tab>{`Notes (${notes.length})`}</Tab>
        <Tab>{`Sources (${sources.length})`}</Tab>
      </TabList>
      <TabPanels>
        <TabPanel>
          <TaskTable tasks={tasks} now={now} hideLegend hideColumns={["slug"]} label={`${tasks.length} open`} />
        </TabPanel>
        <TabPanel>
          <SessionList sessions={summaries} now={now} label={`${sessions.length} most recent`} />
        </TabPanel>
        <TabPanel>
          <FileTable rows={notes.map((note) => ({ id: note.id, title: note.title, tag: note.kind, file: note.filename, changed: note.mtime }))} tagLabel="Kind" />
        </TabPanel>
        <TabPanel>
          <FileTable rows={sources.map((source) => ({ id: source.id, title: source.title, tag: source.type, file: source.filename, changed: source.mtime, nested: source.nested }))} tagLabel="Type" />
        </TabPanel>
      </TabPanels>
    </Tabs>
  );
}

interface FileRow {
  id: string;
  title: string;
  /** A note's kind or a source's type. */
  tag: string;
  file: string;
  changed: string | null;
  nested?: boolean;
}

/** Notes and sources share one listing until react-ui has the knowledge list (TP-859). */
function FileTable({ rows, tagLabel }: { rows: readonly FileRow[]; tagLabel: string }): ReactNode {
  if (rows.length === 0) return <Typography variant="caption" color="secondary">None recorded</Typography>;
  return (
    <Table density="dense">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Title</TableHeaderCell>
          <TableHeaderCell width={120}>{tagLabel}</TableHeaderCell>
          <TableHeaderCell>File</TableHeaderCell>
          <TableHeaderCell width={160}>Changed</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <FileTableRow key={row.id} row={row} />
        ))}
      </TableBody>
    </Table>
  );
}

function FileTableRow({ row }: { row: FileRow }): ReactNode {
  return (
    <TableRow>
      <TableCell>{row.title}</TableCell>
      <TableCell width={120}>
        <HStack gap={1}>
          <Pill variant="subtle" size="xs">
            {row.tag}
          </Pill>
          {row.nested ? (
            <Pill variant="outline" size="xs">
              nested
            </Pill>
          ) : null}
        </HStack>
      </TableCell>
      <TableCell>
        <Typography variant="mono">{row.file}</Typography>
      </TableCell>
      <TableCell width={160}>
        <DateTime value={row.changed} format="datetime" variant="caption" color="secondary" fallback="unknown" />
      </TableCell>
    </TableRow>
  );
}
