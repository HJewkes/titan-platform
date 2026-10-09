import type { ReactNode } from "react";
import {
  Alert,
  DateTime,
  EmptyState,
  HStack,
  Link,
  Pill,
  Section,
  SectionContent,
  SectionHeader,
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
import type { RoundSummary } from "../../server/rounds.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";

const COUNT_WIDTH = 96;

/** Every round in the rounds dir: the open ones waiting for answers first, then the sent ones. */
export function RoundsPage(): ReactNode {
  const list = useQuery("rounds.list");
  if (list.status === "loading") return <Spinner size="sm" label="Loading rounds" />;
  if (list.data === undefined) return <Alert status="error" message={`Could not load rounds: ${list.error?.message ?? "no answer"}`} />;
  const { rounds, truncated } = list.data;
  return (
    <VStack gap={6}>
      {truncated ? <Alert status="warning" message={`Showing the first ${rounds.length} rounds; the rounds dir holds more.`} /> : null}
      <RoundsSection title="Open rounds" subtitle="Waiting for your answers" rounds={rounds.filter((round) => round.status === "open")} empty="No open rounds" />
      <RoundsSection title="Sent rounds" subtitle="Answered; the feedback sits beside the round" rounds={rounds.filter((round) => round.status === "sent")} empty="No sent rounds" />
    </VStack>
  );
}

function RoundsSection({ title, subtitle, rounds, empty }: { title: string; subtitle: string; rounds: readonly RoundSummary[]; empty: string }): ReactNode {
  return (
    <Section>
      <SectionHeader title={title} subtitle={subtitle} />
      <SectionContent>{rounds.length === 0 ? <EmptyState title={empty} /> : <RoundsTable rounds={rounds} />}</SectionContent>
    </Section>
  );
}

function RoundsTable({ rounds }: { rounds: readonly RoundSummary[] }): ReactNode {
  return (
    <Table density="dense">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Round</TableHeaderCell>
          <TableHeaderCell>Unit</TableHeaderCell>
          <TableHeaderCell width={COUNT_WIDTH} align="right">
            Questions
          </TableHeaderCell>
          <TableHeaderCell width={160}>Updated</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rounds.map((round) => (
          <RoundRow key={round.id} round={round} />
        ))}
      </TableBody>
    </Table>
  );
}

function RoundRow({ round }: { round: RoundSummary }): ReactNode {
  return (
    <TableRow testID={`round-row-${round.id}`}>
      <TableCell>
        <HStack gap={2} align="center">
          <Link color="primary" onPress={() => open({ view: "rounds", id: round.id })}>
            {round.id}
          </Link>
          <Pill variant="subtle" size="xs">
            {!round.valid ? "invalid" : round.design ? "design" : "questions"}
          </Pill>
        </HStack>
      </TableCell>
      <TableCell>
        <UnitOrReason round={round} />
      </TableCell>
      <TableCell width={COUNT_WIDTH} align="right">
        {round.valid ? String(round.questions) : "–"}
      </TableCell>
      <TableCell width={160}>
        <DateTime value={round.updatedAt} format="datetime" variant="caption" color="secondary" fallback="unknown" />
      </TableCell>
    </TableRow>
  );
}

/** An invalid round has no unit to show, so its row carries the schema's reason instead. */
function UnitOrReason({ round }: { round: RoundSummary }): ReactNode {
  if (!round.valid) {
    return (
      <Typography variant="caption" color="error">
        {round.reason}
      </Typography>
    );
  }
  return <Typography variant="body2">{`${round.unit} · round ${round.round}`}</Typography>;
}
