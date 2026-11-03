import { useState, type ReactNode } from "react";
import {
  Alert,
  Button,
  ButtonText,
  Chip,
  DateTime,
  HStack,
  Link,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Typography,
  VStack,
} from "@titan-design/react-ui";
import { useQuery } from "../data/rpc.js";
import { open, type Route } from "../router.js";
import { SessionDetailPage } from "./SessionDetailPage.js";
import { useMediaQuery } from "./FramePins.js";
import { BELOW_MD, PHONE_TAP_ID_LINK, PHONE_TAP_LINK } from "./phone.js";
import { GRAPH_STATE, migrationHint, NoneText, RefLinks, formatCost, formatDuration, formatTokens, spanMs, usageTokens, type GraphDegraded, type SessionRow } from "./SessionFormat.js";

const NUMBER_WIDTH = 96;
const PAGE_SIZE = 50;

export function SessionsRoute({ route }: { route: Route }): ReactNode {
  if (route.id) return <SessionDetailPage sessionId={route.id} query={route.query} />;
  const agent = new URLSearchParams(route.query ?? "").get("agent") ?? undefined;
  // Keyed on the filter so a new agent starts again from the first page.
  return <SessionsPage key={agent ?? ""} agent={agent} />;
}

function listArgs(agent: string | undefined, before: string | undefined): { limit: number; agent?: string; before?: string } {
  return { limit: PAGE_SIZE, ...(agent ? { agent } : {}), ...(before ? { before } : {}) };
}

/** Sessions newest first; each "Load more" adds the page before the last one's oldest start. */
function SessionsPage({ agent }: { agent: string | undefined }): ReactNode {
  const first = useQuery("sessions.list", listArgs(agent, undefined));
  if (first.status === "loading") return <Spinner size="sm" label="Loading sessions" />;
  if (first.data === undefined) return <Alert status="error" message={`Could not load sessions: ${first.error?.message ?? "no answer"}`} />;
  const { sessions, degraded } = first.data;
  return (
    <VStack gap={4}>
      {agent ? <AgentFilter agent={agent} /> : null}
      {degraded ? <ListDegraded degraded={degraded} /> : <SessionsBody agent={agent} first={sessions} />}
    </VStack>
  );
}

function SessionsBody({ agent, first }: { agent: string | undefined; first: readonly SessionRow[] }): ReactNode {
  const [cursors, setCursors] = useState<string[]>([]);
  const phone = useMediaQuery(BELOW_MD);
  if (first.length === 0) return <NoSessions />;
  return (
    <VStack gap={3}>
      {phone ? <SessionCards agent={agent} first={first} cursors={cursors} /> : <SessionTable agent={agent} first={first} cursors={cursors} />}
      <LoadMore agent={agent} before={cursors.at(-1)} onMore={(next) => setCursors([...cursors, next])} />
      <IndexedCaption sessions={first} />
    </VStack>
  );
}

function AgentFilter({ agent }: { agent: string }): ReactNode {
  return (
    <HStack gap={2} align="center">
      <Chip variant="subtle" size="sm" onDelete={() => open({ view: "sessions" })}>
        {`agent: ${agent}`}
      </Chip>
    </HStack>
  );
}

function ListDegraded({ degraded }: { degraded: GraphDegraded }): ReactNode {
  const { reason, detail } = degraded;
  const message = `The session list is unavailable: the session graph is ${GRAPH_STATE[reason]}.${migrationHint(degraded)} A session still opens by id from a task or agent page.`;
  return (
    <Alert status="warning" message={message}>
      <Typography variant="caption" color="secondary">
        {detail}
      </Typography>
    </Alert>
  );
}

function NoSessions(): ReactNode {
  return (
    <VStack gap={1}>
      <Typography variant="subtitle1">No sessions recorded</Typography>
      <Typography variant="caption" color="secondary">
        The session graph holds no sessions yet.
      </Typography>
    </VStack>
  );
}

/** The graph exposes no index watermark, so the newest activity on the first page stands in for it. */
function IndexedCaption({ sessions }: { sessions: readonly SessionRow[] }): ReactNode {
  const newest = sessions
    .map((row) => row.endedAt ?? row.startedAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);
  return (
    <Typography variant="caption" color="secondary" testID="sessions-indexed">
      {"Indexed to "}
      <DateTime value={newest} format="datetime" fallback="an unknown time" />
      {". Newer sessions may be missing."}
    </Typography>
  );
}

interface PagedRows {
  agent: string | undefined;
  first: readonly SessionRow[];
  cursors: readonly string[];
}

/** The table's rows as stacked cards on a phone, where its seven columns squeeze over each other; one tree, as on the Tasks list. */
function SessionCards({ agent, first, cursors }: PagedRows): ReactNode {
  return (
    <VStack>
      {first.map((row) => (
        <SessionCard key={row.sessionId} row={row} />
      ))}
      {cursors.map((before) => (
        <OlderCards key={before} agent={agent} before={before} />
      ))}
    </VStack>
  );
}

function OlderCards({ agent, before }: { agent: string | undefined; before: string }): ReactNode {
  const page = useQuery("sessions.list", listArgs(agent, before));
  return page.data?.sessions.map((row) => <SessionCard key={row.sessionId} row={row} />) ?? null;
}

function SessionCard({ row }: { row: SessionRow }): ReactNode {
  const figures = `${formatDuration(spanMs(row.startedAt, row.endedAt))} · ${formatTokens(usageTokens(row))} tokens · ${formatCost(row.costUsd)}`;
  return (
    <VStack gap={1} className="min-w-0 border-b border-divider px-inset-md py-inset-sm" testID={`session-card-${row.sessionId}`}>
      <HStack gap={2} align="center" justify="between" wrap>
        <Link color="primary" className={PHONE_TAP_LINK} testID={`session-link-${row.sessionId}`} onPress={() => open({ view: "sessions", id: row.sessionId })}>
          <DateTime value={row.startedAt} format="datetime" fallback="unknown" />
        </Link>
        {row.agentName ? <AgentFilterLink agent={row.agentName} className={PHONE_TAP_ID_LINK} /> : <NoneText />}
      </HStack>
      <RefLinks refs={[...row.taskIds.map((id) => `task:${id}`), ...row.prs]} />
      <Typography variant="caption" color="secondary" className="break-words">
        {figures}
      </Typography>
    </VStack>
  );
}

function SessionTable({ agent, first, cursors }: PagedRows): ReactNode {
  return (
    <Table density="dense">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Agent</TableHeaderCell>
          <TableHeaderCell>Tasks</TableHeaderCell>
          <TableHeaderCell>PR</TableHeaderCell>
          <TableHeaderCell width={180}>Started</TableHeaderCell>
          {["Duration", "Tokens", "Cost"].map((label) => (
            <TableHeaderCell key={label} width={NUMBER_WIDTH} align="right">
              {label}
            </TableHeaderCell>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {first.map((row) => (
          <SessionTableRow key={row.sessionId} row={row} />
        ))}
        {cursors.map((before) => (
          <OlderRows key={before} agent={agent} before={before} />
        ))}
      </TableBody>
    </Table>
  );
}

function OlderRows({ agent, before }: { agent: string | undefined; before: string }): ReactNode {
  const page = useQuery("sessions.list", listArgs(agent, before));
  return page.data?.sessions.map((row) => <SessionTableRow key={row.sessionId} row={row} />) ?? null;
}

/** Reads the last page the table holds, a cached query, to learn whether an older one exists. */
function LoadMore({ agent, before, onMore }: { agent: string | undefined; before: string | undefined; onMore: (next: string) => void }): ReactNode {
  const page = useQuery("sessions.list", listArgs(agent, before));
  if (page.status === "loading") return <Spinner size="sm" label="Loading sessions" />;
  if (page.data === undefined) return <Alert status="error" message={`Could not load sessions: ${page.error?.message ?? "no answer"}`} />;
  const next = page.data.nextBefore;
  if (next === null) return null;
  return (
    <HStack>
      <Button variant="outline" size="sm" onPress={() => onMore(next)}>
        <ButtonText>Load more</ButtonText>
      </Button>
    </HStack>
  );
}

function SessionTableRow({ row }: { row: SessionRow }): ReactNode {
  return (
    <TableRow testID={`session-row-${row.sessionId}`}>
      <TableCell>{row.agentName ? <AgentFilterLink agent={row.agentName} /> : <NoneText />}</TableCell>
      <TableCell>
        <RefLinks refs={row.taskIds.map((id) => `task:${id}`)} />
      </TableCell>
      <TableCell>
        <RefLinks refs={row.prs} />
      </TableCell>
      <TableCell width={180}>
        <Link color="primary" testID={`session-link-${row.sessionId}`} onPress={() => open({ view: "sessions", id: row.sessionId })}>
          <DateTime value={row.startedAt} format="datetime" fallback="unknown" />
        </Link>
      </TableCell>
      <NumberCell text={formatDuration(spanMs(row.startedAt, row.endedAt))} />
      <NumberCell text={formatTokens(usageTokens(row))} />
      <NumberCell text={formatCost(row.costUsd)} />
    </TableRow>
  );
}

function AgentFilterLink({ agent, className }: { agent: string; className?: string }): ReactNode {
  return (
    <Link color="primary" className={className} onPress={() => open({ view: "sessions", query: `agent=${encodeURIComponent(agent)}` })}>
      {agent}
    </Link>
  );
}

function NumberCell({ text }: { text: string }): ReactNode {
  return (
    <TableCell width={NUMBER_WIDTH} align="right">
      {text}
    </TableCell>
  );
}
