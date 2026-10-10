import type { ReactNode } from "react";
import { Alert, Badge, BadgeText, Card, CardContent, HStack, Section, SectionContent, SectionHeader, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { ActivityRegion, SESSIONS_ARGS } from "./HomeActivity.js";
import { NeedsYouRegion } from "./HomeNeedsYou.js";
import { isWebTarget, openExternal } from "./homeLinks.js";

type Upstream = ConsoleCommands["upstreams.health"]["result"]["upstreams"][number];
type SessionsList = ConsoleCommands["sessions.list"]["result"];

const MISSING = "–";

/** Is anything down, what needs the owner, what moved recently. Every read is a query; nothing here writes. */
export function HomePage(): ReactNode {
  return (
    <VStack gap={6}>
      <HomeSection title="Upstreams" subtitle="The three sources the console reads">
        <UpstreamsRegion />
      </HomeSection>
      <HomeSection title="Status" subtitle="Counts from each upstream">
        <CountsRegion />
      </HomeSection>
      <HomeSection title="Needs you" subtitle="Answer queue items in agent-chat; the console only reads">
        <NeedsYouRegion />
      </HomeSection>
      <HomeSection title="Recent activity" subtitle="The last 24 hours">
        <ActivityRegion />
      </HomeSection>
    </VStack>
  );
}

function HomeSection({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }): ReactNode {
  return (
    <Section>
      <SectionHeader title={title} subtitle={subtitle} />
      <SectionContent>{children}</SectionContent>
    </Section>
  );
}

function UpstreamsRegion(): ReactNode {
  const health = useQuery("upstreams.health");
  if (health.status === "loading") return <Spinner size="sm" label="Loading upstream health" />;
  if (health.data === undefined) return <Alert status="error" message={`Could not load upstream health: ${health.error.message}`} />;
  return (
    <HStack gap={4} wrap>
      {health.data.upstreams.map((upstream) => (
        <UpstreamCard key={upstream.id} upstream={upstream} />
      ))}
    </HStack>
  );
}

// StatCard is unreleased in react-ui ^0.20, so a Card stands in for each tile.
function UpstreamCard({ upstream }: { upstream: Upstream }): ReactNode {
  const onPress = isWebTarget(upstream.target) ? () => openExternal(upstream.target) : undefined;
  return (
    <Card variant="outline" onPress={onPress} testID={`upstream-${upstream.id}`}>
      <CardContent>
        <VStack gap={1}>
          <HStack gap={2} align="center">
            <Typography variant="subtitle2">{upstream.label}</Typography>
            <Badge color={upstream.reachable ? "success" : "error"} variant="subtle" size="sm">
              <BadgeText>{upstream.reachable ? "reachable" : "unreachable"}</BadgeText>
            </Badge>
          </HStack>
          <Typography variant="caption" color="secondary">
            {upstream.target}: {upstream.detail}
          </Typography>
        </VStack>
      </CardContent>
    </Card>
  );
}

function CountsRegion(): ReactNode {
  const health = useQuery("upstreams.health");
  const portfolio = useQuery("work.portfolio");
  const roster = useQuery("agents.roster");
  const sessions = useQuery("sessions.list", SESSIONS_ARGS);
  if ([health, portfolio, roster, sessions].some((query) => query.status === "loading")) return <Spinner size="sm" label="Loading counts" />;
  const down = (health.data?.upstreams ?? []).filter((upstream) => !upstream.reachable);
  const missing = (id: Upstream["id"]) => down.some((upstream) => upstream.id === id);
  const initiatives = missing("work") ? undefined : portfolio.data?.initiatives;
  const tiles = [
    { label: "Open tasks", value: initiatives?.reduce((sum, row) => sum + row.openTasks, 0) },
    { label: "Initiatives", value: initiatives?.length },
    { label: "Live agents", value: missing("agents") ? undefined : roster.data?.agents.filter((agent) => agent.stateSource === "presence").length },
    { label: "Sessions today", value: missing("sessions") ? undefined : sessionsToday(sessions.data) },
  ];
  return (
    <VStack gap={3}>
      {down.map((upstream) => (
        <Alert key={upstream.id} status="warning" message={`${upstream.label} is not answering (${upstream.detail}). Counts from it are missing.`} />
      ))}
      <HStack gap={4} wrap>
        {tiles.map((tile) => (
          <CountTile key={tile.label} label={tile.label} value={tile.value === undefined ? MISSING : String(tile.value)} />
        ))}
      </HStack>
    </VStack>
  );
}

/** A full page of today's sessions means more exist past it, so the count reads as a floor. */
function sessionsToday(list: SessionsList | undefined): string | undefined {
  if (list === undefined || list.degraded !== null) return undefined;
  const midnight = new Date().setHours(0, 0, 0, 0);
  const today = list.sessions.filter((session) => session.startedAt !== null && Date.parse(session.startedAt) >= midnight).length;
  return today === list.sessions.length && list.nextBefore !== null ? `${today}+` : String(today);
}

function CountTile({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <Card variant="outline" testID={`count-${label}`}>
      <CardContent>
        <VStack gap={1}>
          <Typography variant="microLabel" color="secondary">
            {label}
          </Typography>
          <Typography variant="h3">{value}</Typography>
        </VStack>
      </CardContent>
    </Card>
  );
}
