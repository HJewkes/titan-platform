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
  if (list.data === undefined) return <Alert status="error" message={`Could not load rounds: ${list.error.message}`} />;
  const { rounds, truncated, dir } = list.data;
  if (rounds.length === 0 && !truncated) return <NoRounds dir={dir} />;
  return (
    <VStack gap={6}>
      {truncated ? <Alert status="warning" message={`Showing the first ${rounds.length} rounds; the rounds dir holds more.`} /> : null}
      <RoundsSection title="Open rounds" subtitle="Waiting for your answers" rounds={rounds.filter((round) => round.status === "open")} empty="No open rounds" />
      <RoundsSection title="Sent rounds" subtitle="Answered; the feedback sits beside the round" rounds={rounds.filter((round) => round.status === "sent")} empty="No sent rounds" />
    </VStack>
  );
}

/** A blank page left the owner guessing; this names the dir the server reads and the verb that fills it. */
function NoRounds({ dir }: { dir: string }): ReactNode {
  return <EmptyState title="No review rounds yet" description={`The console reads rounds from ${dir}. Import one with: titan-console rounds import <round-dir>`} />;
}

function RoundsSection({ title, subtitle, rounds, empty }: { title: string; subtitle: string; rounds: readonly RoundSummary[]; empty: string }): ReactNode {
  return (
    <Section>
      <SectionHeader title={title} subtitle={subtitle} />
      <SectionContent>{rounds.length === 0 ? <EmptyState title={empty} /> : <RoundsResponsive rounds={rounds} />}</SectionContent>
    </Section>
  );
}

/** Four columns cannot share a phone's width, so below `md` each round stacks into a card; the table is untouched above it. */
function RoundsResponsive({ rounds }: { rounds: readonly RoundSummary[] }): ReactNode {
  return (
    <>
      <div className="hidden md:block">
        <RoundsTable rounds={rounds} />
      </div>
      <div className="md:hidden">
        <RoundsStack rounds={rounds} />
      </div>
    </>
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
        <RoundName round={round} />
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

function RoundsStack({ rounds }: { rounds: readonly RoundSummary[] }): ReactNode {
  return (
    <VStack>
      {rounds.map((round) => (
        <RoundCard key={round.id} round={round} />
      ))}
    </VStack>
  );
}

function RoundCard({ round }: { round: RoundSummary }): ReactNode {
  return (
    <VStack gap={1} className="border-b border-divider px-inset-md py-inset-sm" testID={`round-card-${round.id}`}>
      <RoundName round={round} />
      <UnitOrReason round={round} />
      <HStack gap={3} align="center" wrap>
        {round.valid ? (
          <Typography variant="caption" color="secondary">
            {round.questions === 1 ? "1 question" : `${round.questions} questions`}
          </Typography>
        ) : null}
        <DateTime value={round.updatedAt} format="datetime" variant="caption" color="secondary" fallback="unknown" />
      </HStack>
    </VStack>
  );
}

function RoundName({ round }: { round: RoundSummary }): ReactNode {
  return (
    <HStack gap={2} align="center">
      <Link color="primary" onPress={() => open({ view: "rounds", id: round.id })}>
        {round.id}
      </Link>
      <Pill variant="subtle" size="xs">
        {!round.valid ? "invalid" : round.ship ? "ship" : round.design ? "design" : "questions"}
      </Pill>
    </HStack>
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
