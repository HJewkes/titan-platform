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
import { roundsInSet, setFromQuery } from "./round-set.js";

const COUNT_WIDTH = 96;

const SUPERSEDED_BY = "superseded-by:";

type RoundStatus = RoundSummary["status"];

const STATUS_ORDER: readonly RoundStatus[] = ["open", "sent", "withdrawn"];

const SECTIONS: Record<RoundStatus, { title: string; subtitle: string; empty: string }> = {
  open: { title: "Open rounds", subtitle: "Waiting for your answers", empty: "No open rounds" },
  sent: { title: "Sent rounds", subtitle: "Answered; the feedback sits beside the round", empty: "No sent rounds" },
  withdrawn: { title: "Withdrawn rounds", subtitle: "Superseded or closed before an answer; nothing to answer", empty: "No withdrawn rounds" },
};

/** Every round in the rounds dir, or one set of them under `?set=`: the open ones waiting for answers first, then the sent ones, then the withdrawn ones. */
export function RoundsPage({ query }: { query?: string }): ReactNode {
  const list = useQuery("rounds.list");
  if (list.status === "loading") return <Spinner size="sm" label="Loading rounds" />;
  if (list.data === undefined) return <Alert status="error" message={`Could not load rounds: ${list.error.message}`} />;
  const { truncated, dir } = list.data;
  if (list.data.rounds.length === 0 && !truncated) return <NoRounds dir={dir} />;
  const set = setFromQuery(query);
  const rounds = set === null ? list.data.rounds : roundsInSet(list.data.rounds, set);
  return (
    <VStack gap={6}>
      {truncated ? <Alert status="warning" message={`Showing the first ${list.data.rounds.length} rounds; the rounds dir holds more.`} /> : null}
      {set === null ? null : <SetFilter set={set} count={rounds.length} />}
      {STATUS_ORDER.map((status) => (
        <RoundsSection key={status} status={status} rounds={rounds.filter((round) => round.status === status)} />
      ))}
    </VStack>
  );
}

/** A blank page left the owner guessing; this names the dir the server reads and the verb that fills it. */
function NoRounds({ dir }: { dir: string }): ReactNode {
  return <EmptyState title="No review rounds yet" description={`The console reads rounds from ${dir}. Import one with: titan-console rounds import <round-dir>`} />;
}

/** A set view is reached from a round's up link; this names the set and leads back to every round. */
function SetFilter({ set, count }: { set: string; count: number }): ReactNode {
  return (
    <HStack gap={3} align="center" wrap testID="rounds-set-filter">
      <Typography variant="body2">{`Set ${set} · ${count === 1 ? "1 round" : `${count} rounds`}, earliest first`}</Typography>
      <Link color="primary" onPress={() => open({ view: "rounds" })}>
        All rounds
      </Link>
    </HStack>
  );
}

function RoundsSection({ status, rounds }: { status: RoundStatus; rounds: readonly RoundSummary[] }): ReactNode {
  const { title, subtitle, empty } = SECTIONS[status];
  return (
    <Section testID={`rounds-${status}`}>
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
        {kindOf(round)}
      </Pill>
    </HStack>
  );
}

function kindOf(round: RoundSummary): string {
  if (!round.valid) return "invalid";
  if (round.ship) return "ship";
  if (round.unbound) return "unbound: no merge tap";
  return round.design ? "design" : "questions";
}

/** A withdrawn round also says why it left the queue. */
function UnitOrReason({ round }: { round: RoundSummary }): ReactNode {
  if (round.withdrawnReason === undefined) return <UnitLine round={round} />;
  return (
    <VStack gap={1}>
      <UnitLine round={round} />
      <WithdrawnReason id={round.id} reason={round.withdrawnReason} />
    </VStack>
  );
}

/** A superseded round links to the round that replaced it, so the owner answers that one instead. */
function WithdrawnReason({ id, reason }: { id: string; reason: string }): ReactNode {
  const by = reason.startsWith(SUPERSEDED_BY) ? reason.slice(SUPERSEDED_BY.length) : null;
  return (
    <HStack gap={1} align="center" wrap testID={`round-withdrawn-${id}`}>
      <Typography variant="caption" color="secondary">
        {by === null ? `Withdrawn: ${reason}` : "Superseded by"}
      </Typography>
      {by === null ? null : (
        <Link color="primary" onPress={() => open({ view: "rounds", id: by })}>
          {by}
        </Link>
      )}
    </HStack>
  );
}

/** An invalid round has no unit to show, so its row carries the schema's reason instead. */
function UnitLine({ round }: { round: RoundSummary }): ReactNode {
  if (!round.valid) {
    return (
      <Typography variant="caption" color="error">
        {round.reason}
      </Typography>
    );
  }
  return <Typography variant="body2">{`${round.unit} · round ${round.round}`}</Typography>;
}
