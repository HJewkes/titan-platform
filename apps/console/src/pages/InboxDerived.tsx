import type { ReactNode } from "react";
import { Badge, BadgeText, Card, CardContent, HStack, Link, Section, SectionContent, SectionHeader, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { open, parseRoute } from "../router.js";
import { ageOf } from "./InboxPage.js";
import { PHONE_TAP_ID_LINK } from "./phone.js";

type DerivedRow = ConsoleCommands["inbox.list"]["result"]["derived"][number];

const DERIVED_LABEL: Record<DerivedRow["kind"], string> = { "stalled-run": "stalled", "failed-run": "failed", "blocked-agent": "blocked", "missed-notice": "notice failed" };
const DERIVED_LINK: Record<DerivedRow["kind"], string> = { "stalled-run": "Open the run", "failed-run": "Open the run", "blocked-agent": "Open the agent", "missed-notice": "Open the round" };

/** Exceptions the console derived itself, kept apart from what producers filed; each is a "go look" link with no action. */
export function DerivedSection({ rows }: { rows: readonly DerivedRow[] }): ReactNode {
  return (
    <Section testID="inbox-derived">
      <SectionHeader title={`Raised by the console (${rows.length})`} subtitle="Machine-derived, with evidence; go look" />
      <SectionContent>
        <VStack gap={3}>
          {rows.map((row) => (
            <DerivedRowCard key={row.id} row={row} />
          ))}
        </VStack>
      </SectionContent>
    </Section>
  );
}

function DerivedRowCard({ row }: { row: DerivedRow }): ReactNode {
  const { evidence, threshold } = row;
  return (
    <Card variant="outline" testID={`inbox-derived-${row.id}`}>
      <CardContent>
        <VStack gap={2}>
          <Typography variant="subtitle2">{row.summary}</Typography>
          <HStack gap={2} align="center" wrap>
            <Badge color="warning" variant="subtle" size="sm">
              <BadgeText>{`machine: ${DERIVED_LABEL[row.kind]}`}</BadgeText>
            </Badge>
            <Typography variant="caption" color="secondary">{ageOf(evidence.at)}</Typography>
          </HStack>
          <Typography variant="caption">{`${evidence.observed} (${evidence.source}, since ${evidence.at})`}</Typography>
          <Typography variant="caption" color="secondary">{`Crossed: ${threshold.name}`}</Typography>
          <Link color="primary" className={PHONE_TAP_ID_LINK} onPress={() => open(parseRoute(row.link))}>
            {DERIVED_LINK[row.kind]}
          </Link>
        </VStack>
      </CardContent>
    </Card>
  );
}
