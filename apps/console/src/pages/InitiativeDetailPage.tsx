import { useState, type ReactNode } from "react";
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
  if (detail.data === undefined) return <LoadFailure slug={slug} message={detail.error?.message} />;
  const { initiative, brief, loops, fetchedAt } = detail.data;
  const now = Date.parse(fetchedAt);
  return (
    <VStack gap={4}>
      <Trail slug={slug} />
      <Heading initiative={initiative} />
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

function LoadFailure({ slug, message }: { slug: string; message: string | undefined }): ReactNode {
  return (
    <VStack gap={4}>
      <Trail slug={slug} />
      <Alert status="error" message={`Could not load ${slug}: ${message ?? "no answer"}`} />
    </VStack>
  );
}

function Heading({ initiative }: { initiative: Detail["initiative"] }): ReactNode {
  return (
    <HStack gap={3} align="center" wrap>
      <InitiativeHeader title={initiative.title} slug={initiative.slug} state={initiative.state} rank={initiative.rank} shipTarget={initiative.shipTarget} updated={initiative.updated} />
      {initiative.personal ? <PersonalBadge /> : null}
    </HStack>
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

/** The panel sits outside `Tabs`: in a card of automatic height, react-ui's `TabPanels` gets half the room its content needs. */
function Records({ detail, now }: { detail: Detail; now: number }): ReactNode {
  const [tab, setTab] = useState(0);
  const { openTasks, sessions, notes, sources } = detail;
  const labels = [`Tasks (${openTasks})`, `Sessions (${sessions.length})`, `Notes (${notes.length})`, `Sources (${sources.length})`];
  return (
    <VStack gap={4}>
      <Tabs index={tab} onChange={setTab}>
        <TabList>
          {labels.map((label) => (
            <Tab key={label}>{label}</Tab>
          ))}
        </TabList>
      </Tabs>
      <RecordsPanel tab={tab} detail={detail} now={now} />
    </VStack>
  );
}

function RecordsPanel({ tab, detail, now }: { tab: number; detail: Detail; now: number }): ReactNode {
  const { tasks, sessions, notes, sources } = detail;
  if (tab === 0) {
    const label = tasks.length < detail.openTasks ? `showing first ${tasks.length} of ${detail.openTasks} open` : `${tasks.length} open`;
    return <TaskTable tasks={tasks} now={now} hideLegend hideColumns={["slug"]} label={label} />;
  }
  if (tab === 1) {
    const summaries = sessions.map((session) => ({ ...session, id: session.filename, body: "" }));
    return <SessionList sessions={summaries} now={now} label={`${sessions.length} most recent`} />;
  }
  if (tab === 2) return <FileTable rows={notes.map((note) => ({ id: note.id, title: note.title, tag: note.kind, file: note.filename, changed: note.mtime }))} tagLabel="Kind" />;
  return (
    <VStack gap={2}>
      <FileTable rows={sources.map((source) => ({ id: source.id, title: source.title, tag: source.type, file: source.filename, changed: source.mtime }))} tagLabel="Type" />
      {detail.nestedSources > 0 ? (
        <Typography variant="caption" color="secondary">
          {`${detail.nestedSources} nested ${detail.nestedSources === 1 ? "file" : "files"} under sources/ ${detail.nestedSources === 1 ? "is" : "are"} counted here and not listed.`}
        </Typography>
      ) : null}
    </VStack>
  );
}

interface FileRow {
  id: string;
  title: string;
  /** A note's kind or a source's type. */
  tag: string;
  file: string;
  changed: string | null;
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
        <Pill variant="subtle" size="xs">
          {row.tag}
        </Pill>
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
