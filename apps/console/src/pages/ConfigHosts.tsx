import type { ReactNode } from "react";
import { Alert, Badge, BadgeText, Card, CardContent, EmptyState, HStack, Section, SectionContent, SectionHeader, Spinner, Typography, VStack } from "@titan-design/react-ui";
import { useQuery, type ServedCommands } from "../data/rpc.js";

type Hosts = ServedCommands["config.hosts"]["result"];
type HostView = Hosts["hosts"][number];

/** Every other host's last config report; a stale one says "not reported" rather than showing an old reading as current. */
export function HostsSection(): ReactNode {
  const hosts = useQuery("config.hosts");
  if (hosts.status === "loading") return <Spinner size="sm" label="Loading hosts" />;
  if (hosts.data === undefined) return <Alert status="error" message={`Could not load host reports: ${hosts.error.message}`} />;
  const { hosts: rows, gaps } = hosts.data;
  const silent = rows.filter((host) => host.status === "not reported").length;
  return (
    <Section testID="config-hosts">
      <SectionHeader title={`Hosts (${rows.length})`} subtitle={silent > 0 ? `${silent} not reported in the last 25 hours` : "Each other host's last config report"} />
      <SectionContent>
        <VStack gap={3}>
          {rows.length === 0 ? <EmptyState title="No other host has reported" /> : null}
          {rows.map((host) => (
            <HostCard key={host.host} host={host} />
          ))}
          {gaps.map((gap) => (
            <Typography key={gap} variant="caption" color="secondary" className="break-all">{gap}</Typography>
          ))}
        </VStack>
      </SectionContent>
    </Section>
  );
}

function HostCard({ host }: { host: HostView }): ReactNode {
  const reported = host.status === "reported";
  return (
    <Card variant="outline" testID={`config-host-${host.host}`}>
      <CardContent>
        <VStack gap={2}>
          <HStack gap={2} align="center" wrap>
            <Typography variant="subtitle2">{host.host}</Typography>
            <Badge color={reported ? "default" : "warning"} variant="subtle" size="sm">
              <BadgeText>{host.status}</BadgeText>
            </Badge>
          </HStack>
          <Typography variant="body2" testID="config-host-last-report">{`Last report ${host.reportedAt}`}</Typography>
          <Typography variant="caption" color="secondary">
            {reported ? `${host.platform}, ${host.surfaces.length} surfaces reported` : `${host.platform}, older than 25 hours, so its surfaces are not shown`}
          </Typography>
        </VStack>
      </CardContent>
    </Card>
  );
}
