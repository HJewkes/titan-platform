import type { ReactNode } from "react";
import { Alert, Badge, BadgeText, Card, CardContent, DataRow, Section, SectionContent, SectionHeader, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";

type UpstreamHealth = ConsoleCommands["upstreams.health"]["result"]["upstreams"][number];

/** Whether each source the console fronts can be reached right now. */
export function StatusPage(): ReactNode {
  const health = useQuery("upstreams.health");
  if (health.status === "loading") return <Spinner size="sm" label="Loading upstream health" />;
  if (health.data === undefined) return <Alert status="error" message={`Could not load upstream health: ${health.error?.message ?? "no answer"}`} />;
  const { upstreams, checkedAt } = health.data;
  return (
    <Section>
      <SectionHeader title="Upstreams" subtitle={`Checked ${new Date(checkedAt).toLocaleString("en-US")}`} />
      <SectionContent>
        <Card>
          <CardContent>
            {upstreams.map((upstream) => (
              <DataRow key={upstream.id} label={<UpstreamLabel upstream={upstream} />} value={<Reachability reachable={upstream.reachable} />} />
            ))}
          </CardContent>
        </Card>
      </SectionContent>
    </Section>
  );
}

function UpstreamLabel({ upstream }: { upstream: UpstreamHealth }): ReactNode {
  return (
    <VStack>
      <Typography variant="body2">{upstream.label}</Typography>
      <Typography variant="caption" color="secondary">
        {upstream.target}: {upstream.detail}
      </Typography>
    </VStack>
  );
}

function Reachability({ reachable }: { reachable: boolean }): ReactNode {
  return (
    <Badge color={reachable ? "success" : "error"} variant="subtle" size="sm">
      <BadgeText>{reachable ? "reachable" : "unreachable"}</BadgeText>
    </Badge>
  );
}
