import type { ReactNode } from "react";
import {
  Alert,
  Avatar,
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
import { AgentDetailPage } from "./AgentDetailPage.js";
import { BrokerFailure, MessageFeed, RouteTabs, StatePill, formatCost, tabFrom, type RosterEntry } from "./AgentParts.js";

const TABS = [
  ["roster", "Roster"],
  ["messages", "Messages"],
] as const;

export function AgentsRoute({ route }: { route: Route }): ReactNode {
  return route.id ? <AgentDetailPage name={route.id} route={route} /> : <AgentsPage route={route} />;
}

/** The broker's agents and what they said to each other; the Tree tab waits for TP-2128. */
function AgentsPage({ route }: { route: Route }): ReactNode {
  const tab = tabFrom(route, TABS.map(([key]) => key));
  return (
    <VStack gap={4}>
      <Typography variant="h4">Agents</Typography>
      <RouteTabs route={route} tabs={TABS} current={tab} />
      {tab === "roster" ? <Roster /> : <MessageFeed empty="No messages in the broker's last 1,000 events." />}
    </VStack>
  );
}

function Roster(): ReactNode {
  const roster = useQuery("agents.roster");
  if (roster.status === "loading") return <Spinner size="sm" label="Loading agents" />;
  if (roster.data === undefined) return <BrokerFailure message={roster.error?.message} />;
  const { agents, reconnecting } = roster.data;
  return (
    <VStack gap={3}>
      {reconnecting ? <Alert status="warning" message="The broker restarted moments ago and is still refilling presence; a missing live agent may not have exited." /> : null}
      {agents.length === 0 ? <NoAgents /> : <RosterTable agents={agents} />}
    </VStack>
  );
}

function NoAgents(): ReactNode {
  return (
    <VStack gap={1}>
      <Typography variant="subtitle1">No agents</Typography>
      <Typography variant="caption" color="secondary">
        The agent-chat broker knows no agents.
      </Typography>
    </VStack>
  );
}

function RosterTable({ agents }: { agents: readonly RosterEntry[] }): ReactNode {
  return (
    <Table density="dense">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Agent</TableHeaderCell>
          <TableHeaderCell width={110}>State</TableHeaderCell>
          <TableHeaderCell>Working on</TableHeaderCell>
          <TableHeaderCell width={140}>Spawned by</TableHeaderCell>
          <TableHeaderCell width={170}>Last seen</TableHeaderCell>
          <TableHeaderCell width={90} align="right">
            Cost
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((agent) => (
          <RosterRow key={agent.id} agent={agent} />
        ))}
      </TableBody>
    </Table>
  );
}

function RosterRow({ agent }: { agent: RosterEntry }): ReactNode {
  return (
    <TableRow testID={`agent-row-${agent.name}`}>
      <TableCell>
        <HStack gap={2} align="center">
          <Avatar size="xs" colorFromName={agent.name} alt={agent.name} />
          <Link color="primary" onPress={() => open({ view: "agents", id: agent.name })}>
            {agent.name}
          </Link>
        </HStack>
      </TableCell>
      <TableCell width={110}>
        <StatePill state={agent.state} />
      </TableCell>
      <TableCell>{agent.workingOn ?? "–"}</TableCell>
      <TableCell width={140}>{agent.spawnedBy ?? "–"}</TableCell>
      <TableCell width={170}>
        <DateTime value={agent.lastEventAt} format="datetime" variant="caption" color="secondary" fallback="unknown" />
      </TableCell>
      <TableCell width={90} align="right">
        {formatCost(agent.costUsd)}
      </TableCell>
    </TableRow>
  );
}
