import type { ReactNode } from "react";
import {
  Alert,
  Avatar,
  DateTime,
  ListItem,
  ListItemContent,
  ListItemDivider,
  ListItemTrailing,
  Pill,
  Spinner,
  Tab,
  TabList,
  Tabs,
  Typography,
  VStack,
  type PillTone,
} from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { open, type Route } from "../router.js";

export type RosterEntry = ConsoleCommands["agents.roster"]["result"]["agents"][number];
type Message = ConsoleCommands["agents.messages"]["result"]["messages"][number];

export const WINDOW_CAPTION = "Counted over the broker's last 1,000 events.";

/** The tab a `?tab=` deep link names, else the first. */
export function tabFrom<Key extends string>(route: Route, keys: readonly Key[]): Key {
  const asked = new URLSearchParams(route.query ?? "").get("tab");
  return keys.find((key) => key === asked) ?? keys[0]!;
}

/** The panel sits outside `Tabs`, as on the initiative page, so `TabPanels` cannot squeeze it. */
export function RouteTabs<Key extends string>({ route, tabs, current }: { route: Route; tabs: readonly (readonly [Key, string])[]; current: Key }): ReactNode {
  const index = tabs.findIndex(([key]) => key === current);
  const select = (next: number) => open({ view: route.view, ...(route.id ? { id: route.id } : {}), query: `tab=${tabs[next]![0]}` });
  return (
    <Tabs index={index} onChange={select}>
      <TabList>
        {tabs.map(([key, label]) => (
          <Tab key={key}>{label}</Tab>
        ))}
      </TabList>
    </Tabs>
  );
}

/** The server message already names the broker's port or the token file, so it is shown whole. */
export function BrokerFailure({ message }: { message: string | undefined }): ReactNode {
  return <Alert status="error" message={`Could not load agents: ${message ?? "no answer"}`} />;
}

const STATE_TONE: Record<RosterEntry["state"], PillTone> = {
  working: "success",
  available: "info",
  blocked: "warning",
  spawning: "info",
  detached: "neutral",
  exited: "neutral",
  failed: "error",
  retired: "neutral",
};

export function StatePill({ state }: { state: RosterEntry["state"] }): ReactNode {
  return (
    <Pill variant="subtle" size="xs" tone={STATE_TONE[state]}>
      {state}
    </Pill>
  );
}

export function formatCost(costUsd: number | null): string {
  return costUsd === null ? "–" : `$${costUsd.toFixed(2)}`;
}

/** Messages newest first; `agent` narrows to one agent's sent and received. */
export function MessageFeed({ agent, empty }: { agent?: string; empty: string }): ReactNode {
  const feed = useQuery("agents.messages", agent === undefined ? {} : { agent });
  if (feed.status === "loading") return <Spinner size="sm" label="Loading messages" />;
  if (feed.data === undefined) return <BrokerFailure message={feed.error?.message} />;
  const { messages } = feed.data;
  return (
    <VStack gap={2}>
      <Typography variant="caption" color="secondary">
        {WINDOW_CAPTION}
      </Typography>
      {messages.length === 0 ? <Typography variant="body2">{empty}</Typography> : <MessageRows messages={messages} />}
    </VStack>
  );
}

function MessageRows({ messages }: { messages: readonly Message[] }): ReactNode {
  return (
    <VStack>
      {messages.map((message, index) => (
        <VStack key={message.msgId}>
          {index > 0 ? <ListItemDivider /> : null}
          <MessageRow message={message} />
        </VStack>
      ))}
    </VStack>
  );
}

/** Message text is another agent's words, so it renders as plain text, never markdown. */
function MessageRow({ message }: { message: Message }): ReactNode {
  const title = `${message.from} → ${message.to ?? "everyone"}${message.kind === "message" ? "" : ` · ${message.kind}`}`;
  return (
    <ListItem testID={`message-${message.msgId}`} onPress={() => open({ view: "agents", id: message.from })}>
      <Avatar size="sm" colorFromName={message.from} alt={message.from} className="mr-3" />
      <ListItemContent title={title} subtitle={message.text} />
      <ListItemTrailing>
        <DateTime value={message.at} format="datetime" variant="caption" color="secondary" />
      </ListItemTrailing>
    </ListItem>
  );
}
