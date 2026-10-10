import type { ReactNode } from "react";
import { Alert, Card, CardContent, DateTime, EmptyState, ListItem, ListItemContent, ListItemTrailing, Spinner, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";
import { followRef } from "./homeLinks.js";

type Initiative = ConsoleCommands["work.portfolio"]["result"]["initiatives"][number];
type Session = ConsoleCommands["sessions.list"]["result"]["sessions"][number];

/** Shared with the counts, so both regions read one cached page of sessions. */
export const SESSIONS_ARGS = { limit: 200 };

const WINDOW_MS = 24 * 60 * 60 * 1000;
const ROW_LIMIT = 10;

interface Activity {
  key: string;
  title: string;
  subtitle: string;
  at: string;
  onPress: () => void;
}

function initiativeActivity(rows: readonly Initiative[]): Activity[] {
  return rows.flatMap((row) =>
    row.newestActivity === null
      ? []
      : [{ key: `initiative-${row.slug}`, title: row.title, subtitle: `Initiative ${row.slug} changed`, at: row.newestActivity, onPress: () => open({ view: "initiatives", id: row.slug }) }],
  );
}

function sessionActivity(rows: readonly Session[]): Activity[] {
  return rows.flatMap((row) =>
    row.startedAt === null
      ? []
      : [{ key: `session-${row.sessionId}`, title: row.title ?? row.sessionId, subtitle: row.agentName ? `Session started by ${row.agentName}` : "Session started", at: row.startedAt, onPress: () => followRef(`session:${row.sessionId}`) }],
  );
}

function recent(activity: readonly Activity[], now: number): Activity[] {
  return activity
    .filter((item) => now - Date.parse(item.at) <= WINDOW_MS)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, ROW_LIMIT);
}

/** What moved in the last day, newest first: initiatives with fresh records and sessions that started. */
export function ActivityRegion(): ReactNode {
  const portfolio = useQuery("work.portfolio");
  const sessions = useQuery("sessions.list", SESSIONS_ARGS);
  if (portfolio.status === "loading" || sessions.status === "loading") return <Spinner size="sm" label="Loading activity" />;
  const rows = recent([...initiativeActivity(portfolio.data?.initiatives ?? []), ...sessionActivity(sessions.data?.sessions ?? [])], Date.now());
  return (
    <VStack gap={3}>
      {portfolio.status === "error" ? <Alert status="warning" message={`Could not load initiatives: ${portfolio.error.message}`} /> : null}
      {sessions.status === "error" ? <Alert status="warning" message={`Could not load sessions: ${sessions.error.message}`} /> : null}
      {sessions.data?.degraded ? <Alert status="warning" message={`Sessions are missing from activity: ${sessions.data.degraded.detail}`} /> : null}
      {rows.length > 0 ? <ActivityList rows={rows} /> : <EmptyState title="No activity in the last 24 hours." />}
    </VStack>
  );
}

function ActivityList({ rows }: { rows: readonly Activity[] }): ReactNode {
  return (
    <Card variant="outline">
      <CardContent>
        {rows.map((row) => (
          <ListItem key={row.key} onPress={row.onPress} testID={`activity-${row.key}`}>
            <ListItemContent title={row.title} subtitle={row.subtitle} />
            <ListItemTrailing>
              <DateTime value={row.at} format="relative" variant="caption" color="secondary" />
            </ListItemTrailing>
          </ListItem>
        ))}
      </CardContent>
    </Card>
  );
}
