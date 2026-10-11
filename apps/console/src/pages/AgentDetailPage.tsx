import type { ReactNode } from "react";
import {
  Alert,
  Avatar,
  BreadcrumbItem,
  Breadcrumbs,
  Card,
  CardContent,
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
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { open, type Route } from "../router.js";
import { BrokerFailure, MessageFeed, RouteTabs, StatePill, formatCost, tabFrom, type RosterEntry } from "./AgentParts.js";

type SessionsList = ConsoleCommands["sessions.list"]["result"];
type SessionRow = SessionsList["sessions"][number];
type GraphReason = NonNullable<SessionsList["degraded"]>["reason"];

const TABS = [
  ["runs", "Runs"],
  ["messages", "Messages"],
] as const;

const RUNS_PAGE = 50;

const GRAPH_STATE: Record<GraphReason, string> = {
  "graph-missing": "missing",
  "graph-not-migrated": "older than this console",
  "graph-unreadable": "unreadable",
  "transcript-missing": "missing a transcript",
};

/** One agent: its roster card, then its runs from the session graph and its messages from the broker. */
export function AgentDetailPage({ name, route }: { name: string; route: Route }): ReactNode {
  const roster = useQuery("agents.roster");
  if (roster.status === "loading") return <Spinner size="sm" label="Loading agent" />;
  if (roster.data === undefined) {
    return (
      <VStack gap={4}>
        <Trail name={name} />
        <BrokerFailure message={roster.error.message} />
      </VStack>
    );
  }
  const entry = roster.data.agents.find((agent) => agent.name === name);
  const tab = tabFrom(route, TABS.map(([key]) => key));
  return (
    <VStack gap={4}>
      <Trail name={name} />
      {entry ? <AgentCard agent={entry} /> : <Alert status="info" message={`No agent named ${name} in the broker's roster or its last 1,000 events.`} />}
      <RouteTabs route={route} tabs={TABS} current={tab} />
      {tab === "runs" ? <Runs name={name} /> : <MessageFeed agent={name} empty={`No messages to or from ${name} in the broker's last 1,000 events.`} />}
    </VStack>
  );
}

function Trail({ name }: { name: string }): ReactNode {
  return (
    <Breadcrumbs>
      <BreadcrumbItem onPress={() => open({ view: "agents" })}>Agents</BreadcrumbItem>
      <BreadcrumbItem isCurrentPage>{name}</BreadcrumbItem>
    </Breadcrumbs>
  );
}

/** Card and Avatar stand in for react-ui's AgentCard until TP-858 is released. */
function AgentCard({ agent }: { agent: RosterEntry }): ReactNode {
  const facts = [
    agent.spawnedBy ? `Spawned by ${agent.spawnedBy}` : null,
    agent.taskId ? `Task ${agent.taskId}` : null,
    agent.gitBranch ? `Branch ${agent.gitBranch}` : null,
    agent.costUsd === null ? null : `Cost ${formatCost(agent.costUsd)}`,
  ].filter((fact): fact is string => fact !== null);
  return (
    <Card testID="agent-card">
      <CardContent>
        <HStack gap={3} align="center">
          <Avatar size="lg" colorFromName={agent.name} alt={agent.name} />
          <VStack gap={1}>
            <HStack gap={2} align="center">
              <Typography variant="h5">{agent.name}</Typography>
              <StatePill state={agent.state} />
            </HStack>
            {agent.workingOn ? <Typography variant="body2">{agent.workingOn}</Typography> : null}
            {facts.length > 0 ? (
              <Typography variant="caption" color="secondary">
                {facts.join(" · ")}
              </Typography>
            ) : null}
          </VStack>
        </HStack>
      </CardContent>
    </Card>
  );
}

function Runs({ name }: { name: string }): ReactNode {
  const runs = useQuery("sessions.list", { agent: name, limit: RUNS_PAGE });
  if (runs.status === "loading") return <Spinner size="sm" label="Loading sessions" />;
  if (runs.data === undefined) return <Alert status="error" message={`Could not load sessions: ${runs.error.message}`} />;
  const { sessions, degraded } = runs.data;
  if (degraded) return <GraphDegraded reason={degraded.reason} detail={degraded.detail} />;
  if (sessions.length === 0) return <Typography variant="body2">{`No sessions recorded for ${name}.`}</Typography>;
  return <RunsTable sessions={sessions} />;
}

function GraphDegraded({ reason, detail }: { reason: GraphReason; detail: string }): ReactNode {
  const message = `The session list is unavailable: the session graph is ${GRAPH_STATE[reason]}. A session still opens by id from a task or agent page.`;
  return (
    <Alert status="warning" message={message}>
      <Typography variant="caption" color="secondary">
        {detail}
      </Typography>
    </Alert>
  );
}

function RunsTable({ sessions }: { sessions: readonly SessionRow[] }): ReactNode {
  return (
    <Table density="dense">
      <TableHeader>
        <TableRow>
          <TableHeaderCell width={180}>Started</TableHeaderCell>
          <TableHeaderCell>Title</TableHeaderCell>
          <TableHeaderCell>Tasks</TableHeaderCell>
          <TableHeaderCell width={80} align="right">
            Turns
          </TableHeaderCell>
          <TableHeaderCell width={90} align="right">
            Cost
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sessions.map((session) => (
          <RunRow key={session.sessionId} session={session} />
        ))}
      </TableBody>
    </Table>
  );
}

function RunRow({ session }: { session: SessionRow }): ReactNode {
  return (
    <TableRow testID={`run-row-${session.sessionId}`}>
      <TableCell width={180}>
        <Link color="primary" onPress={() => open({ view: "sessions", id: session.sessionId })}>
          <DateTime value={session.startedAt} format="datetime" fallback="unknown" />
        </Link>
      </TableCell>
      <TableCell>{session.title ?? "–"}</TableCell>
      <TableCell>{session.taskIds.length > 0 ? session.taskIds.join(", ") : "–"}</TableCell>
      <TableCell width={80} align="right">
        {String(session.turnCount)}
      </TableCell>
      <TableCell width={90} align="right">
        {formatCost(session.costUsd)}
      </TableCell>
    </TableRow>
  );
}
