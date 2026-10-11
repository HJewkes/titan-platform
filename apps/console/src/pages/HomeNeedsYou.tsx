import type { ReactNode } from "react";
import { Alert, Badge, BadgeText, Card, CardContent, EmptyState, Link, ListItem, ListItemContent, ListItemTrailing, Spinner, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { followRef, isWebTarget, openExternal, queueUrl } from "./homeLinks.js";

type QueueItem = ConsoleCommands["agents.queue"]["result"]["items"][number];
type TaskRow = ConsoleCommands["work.tasks"]["result"]["tasks"][number];
type Upstream = ConsoleCommands["upstreams.health"]["result"]["upstreams"][number];

interface Need {
  key: string;
  title: string;
  subtitle: string;
  badge: string;
  color: "info" | "warning" | "error";
  onPress?: () => void;
}

const TITLE_LIMIT = 140;

const firstLine = (text: string): string => {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line;
};

function needsOf(queue: readonly QueueItem[], tasks: readonly TaskRow[], upstreams: readonly Upstream[], url: string): Need[] {
  const asked = queue.map((item): Need => ({ key: `queue-${item.msgId}`, title: firstLine(item.text), subtitle: `${item.kind} from ${item.asker}`, badge: "queue", color: "info", onPress: () => openExternal(url) }));
  const blocked = tasks
    .filter((task) => task.stage === "blocked")
    .map((task): Need => ({ key: `task-${task.id}`, title: `${task.id} ${task.title}`, subtitle: task.stageReason, badge: "blocked", color: "warning", onPress: () => followRef(`task:${task.id}`) }));
  const down = upstreams
    .filter((upstream) => !upstream.reachable)
    .map((upstream): Need => ({
      key: `upstream-${upstream.id}`,
      title: `${upstream.label} is not answering`,
      subtitle: `${upstream.target}: ${upstream.detail}`,
      badge: "unreachable",
      color: "error",
      ...(isWebTarget(upstream.target) ? { onPress: () => openExternal(upstream.target) } : {}),
    }));
  return [...asked, ...blocked, ...down];
}

/** Open queue items, blocked tasks and unreachable upstreams; every row links out, none answers anything. */
export function NeedsYouRegion(): ReactNode {
  const health = useQuery("upstreams.health");
  const queue = useQuery("agents.queue");
  const tasks = useQuery("work.tasks");
  if ([health, queue, tasks].some((query) => query.status === "loading")) return <Spinner size="sm" label="Loading needs-you" />;
  const url = queueUrl(health.data?.upstreams.find((upstream) => upstream.id === "agents")?.target);
  const needs = needsOf(queue.data?.items ?? [], tasks.data?.tasks ?? [], health.data?.upstreams ?? [], url);
  // A failed read leaves its rows unknown, so the list may not claim nothing needs the owner; the Upstreams region reports a health failure.
  const failed = [health, queue, tasks].some((query) => query.status === "error");
  return (
    <VStack gap={3}>
      {queue.status === "error" ? <QueueUnreadable message={queue.error.message} url={url} /> : null}
      {tasks.status === "error" ? <Alert status="warning" message={`Could not load blocked tasks: ${tasks.error.message}`} /> : null}
      {needs.length > 0 ? <NeedList needs={needs} /> : failed ? null : <EmptyState title="Nothing needs you" description="No open queue items, blocked tasks or unreachable upstreams." />}
    </VStack>
  );
}

function QueueUnreadable({ message, url }: { message: string; url: string }): ReactNode {
  return (
    <Alert status="warning" message={`The agent-chat queue is unreadable: ${message}.`}>
      <Link color="primary" href={url} isExternal onPress={() => openExternal(url)}>
        Open agent-chat
      </Link>
    </Alert>
  );
}

function NeedList({ needs }: { needs: readonly Need[] }): ReactNode {
  return (
    <Card variant="outline">
      <CardContent>
        {needs.map((need) => (
          <ListItem key={need.key} onPress={need.onPress} testID={`need-${need.key}`}>
            <ListItemContent title={need.title} subtitle={need.subtitle} />
            <ListItemTrailing>
              <Badge color={need.color} variant="subtle" size="sm">
                <BadgeText>{need.badge}</BadgeText>
              </Badge>
            </ListItemTrailing>
          </ListItem>
        ))}
      </CardContent>
    </Card>
  );
}
