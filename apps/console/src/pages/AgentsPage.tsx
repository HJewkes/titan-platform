import { useState, type ReactNode } from "react";
import {
  Alert,
  Avatar,
  Checkbox,
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
import { PHONE_TAP, usePhone, usePhoneTap } from "./phone.js";

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
      <RouteTabs route={route} tabs={TABS} current={tab} />
      {tab === "roster" ? <Roster /> : <MessageFeed empty="No messages in the broker's last 1,000 events." />}
    </VStack>
  );
}

function Roster(): ReactNode {
  const roster = useQuery("agents.roster");
  if (roster.status === "loading") return <Spinner size="sm" label="Loading agents" />;
  if (roster.data === undefined) return <BrokerFailure message={roster.error.message} />;
  return <RosterBody roster={roster.data} />;
}

/** "Finished, not retired" keeps the exited rows, the ones an agent page offers to retire. */
function RosterBody({ roster: { agents, reconnecting } }: { roster: { agents: readonly RosterEntry[]; reconnecting: boolean } }): ReactNode {
  const [finished, setFinished] = useState(false);
  const shown = finished ? agents.filter((agent) => agent.state === "exited") : agents;
  const tap = usePhoneTap();
  return (
    <VStack gap={3}>
      {reconnecting ? <Alert status="warning" message="The broker restarted moments ago and is still refilling presence; a missing live agent may not have exited." /> : null}
      {agents.length === 0 ? null : <Checkbox label="Finished, not retired" className={tap} isChecked={finished} onCheckedChange={(checked: boolean) => setFinished(checked)} testID="agents-finished" />}
      {agents.length === 0 ? <NoAgents /> : <RosterRows agents={shown} />}
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

/** One tree, not a CSS swap of two, as on the Tasks list. */
function RosterRows({ agents }: { agents: readonly RosterEntry[] }): ReactNode {
  return usePhone() ? <RosterCards agents={agents} /> : <RosterTable agents={agents} />;
}

function RosterCards({ agents }: { agents: readonly RosterEntry[] }): ReactNode {
  return (
    <VStack>
      {agents.map((agent) => (
        <RosterCard key={agent.id} agent={agent} />
      ))}
    </VStack>
  );
}

function RosterCard({ agent }: { agent: RosterEntry }): ReactNode {
  return (
    <VStack gap={1} className="min-w-0 border-b border-divider px-inset-md py-inset-sm" testID={`agent-card-${agent.name}`}>
      <HStack gap={2} align="center" justify="between">
        <HStack gap={2} align="center" className="min-w-0">
          <Avatar size="xs" colorFromName={agent.name} alt={agent.name} />
          <Link color="primary" className={`${PHONE_TAP} break-words`} onPress={() => open({ view: "agents", id: agent.name })}>
            {agent.name}
          </Link>
        </HStack>
        <StatePill state={agent.state} />
      </HStack>
      {agent.workingOn ? <Typography variant="body2" className="break-words">{agent.workingOn}</Typography> : null}
      <Typography variant="caption" color="secondary" className="break-words">
        {`${agent.spawnedBy ? `Spawned by ${agent.spawnedBy} · ` : ""}${formatCost(agent.costUsd)} · last seen `}
        <DateTime value={agent.lastEventAt} format="datetime" fallback="unknown" />
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
