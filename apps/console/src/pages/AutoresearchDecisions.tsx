import type { ReactNode } from "react";
import {
  Accordion,
  AccordionButton,
  AccordionItem,
  AccordionPanel,
  EmptyState,
  Pill,
  type PillTone,
  Section,
  SectionContent,
  SectionHeader,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@titan-design/react-ui";
import type { ArLadder, ArOutcome, ArRound, ArRunView } from "../../server/autoresearch-view.js";
import { RatchetMove } from "./AutoresearchRatchet.js";
import { AutoresearchRoundPlanner } from "./AutoresearchRoundPlanner.js";
import { AutoresearchRoundSettle } from "./AutoresearchRoundSettle.js";
import { keptMove, reasonText, shortId, signed } from "./autoresearch-format.js";
import { formatCost } from "./SessionFormat.js";

type Decided = ArLadder & { outcome: ArOutcome };

const VERDICT_TONE: Record<ArOutcome["verdict"], PillTone> = { kept: "success", rejected: "error", stopped: "neutral" };

const SECONDS_PER_MINUTE = 60;

/** Below this the decisions scroll sideways rather than squeeze their ten columns into overlap. */
const DECISIONS_MIN_WIDTH = 1040;

/** Design §1.4: decisions grouped by round, the newest open and the earlier ones collapsed. */
export function AutoresearchDecisions({ run }: { run: ArRunView }): ReactNode {
  const newestFirst = [...run.rounds].reverse();
  return (
    <Section testID="autoresearch-decisions">
      <SectionHeader title="Decisions" subtitle="This round, then every earlier round" />
      <SectionContent>
        <Accordion allowMultiple defaultIndex={[0]}>
          {newestFirst.map((round) => (
            <AccordionItem key={round.round}>
              <AccordionButton>{roundTitle(round)}</AccordionButton>
              <AccordionPanel>
                <AutoresearchRoundPlanner round={round} />
                <RoundDecisions run={run} round={round} />
                <AutoresearchRoundSettle run={run} round={round} />
              </AccordionPanel>
            </AccordionItem>
          ))}
        </Accordion>
      </SectionContent>
    </Section>
  );
}

const decided = (round: ArRound): Decided[] => round.ladders.filter((ladder): ladder is Decided => ladder.outcome !== null);

function roundTitle(round: ArRound): string {
  const running = round.ladders.length - decided(round).length;
  return `Round ${round.round} · ${decided(round).length} decided${running > 0 ? ` · ${running} still on the ladder` : ""}`;
}

function RoundDecisions({ run, round }: { run: ArRunView; round: ArRound }): ReactNode {
  const rows = decided(round);
  if (rows.length === 0) return <EmptyState title="No idea has reached a decision this round" />;
  return (
    <Table density="dense" contentMinWidth={DECISIONS_MIN_WIDTH}>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Idea</TableHeaderCell>
          <TableHeaderCell>Cell</TableHeaderCell>
          <TableHeaderCell>Verdict</TableHeaderCell>
          <TableHeaderCell>Rung</TableHeaderCell>
          <TableHeaderCell>Reason</TableHeaderCell>
          <TableHeaderCell>{`Δ ${run.target.metric.primary}`}</TableHeaderCell>
          <TableHeaderCell>Runs</TableHeaderCell>
          <TableHeaderCell>Spend</TableHeaderCell>
          <TableHeaderCell>Wall</TableHeaderCell>
          <TableHeaderCell>Ratchet</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((ladder) => (
          <DecisionRow key={ladder.idea.id} target={run.target} round={round} ladder={ladder} />
        ))}
      </TableBody>
    </Table>
  );
}

function DecisionRow({ target, round, ladder }: { target: ArRunView["target"]; round: ArRound; ladder: Decided }): ReactNode {
  const { idea, outcome } = ladder;
  const { primary } = target.metric;
  const move = keptMove(round, outcome);
  return (
    <TableRow testID={`autoresearch-decision-${idea.id}`}>
      <TableCell>{shortId(idea.id)}</TableCell>
      <TableCell>{idea.cell}</TableCell>
      <TableCell>
        <Pill variant="subtle" size="xs" tone={VERDICT_TONE[outcome.verdict]}>
          {outcome.verdict}
        </Pill>
      </TableCell>
      <TableCell>{outcome.rungReached}</TableCell>
      <TableCell>{reasonText(outcome.reason)}</TableCell>
      <TableCell>{deltaText(outcome)}</TableCell>
      <TableCell>{ladder.evals.map((entry) => `${entry.repeat} ${entry.metrics[primary] ?? "—"}`).join(" · ") || "—"}</TableCell>
      <TableCell>{formatCost(ladder.evals.reduce((sum, entry) => sum + entry.usd, ladder.implementUsd ?? 0))}</TableCell>
      <TableCell>{wallText(ladder)}</TableCell>
      <TableCell>{move === null ? "—" : <RatchetMove repo={target.repo} move={move} />}</TableCell>
    </TableRow>
  );
}

function deltaText(outcome: ArOutcome): string {
  if (outcome.delta === undefined) return "—";
  const inSigma = outcome.sigma === undefined || outcome.sigma === 0 ? "" : ` · ${signed(outcome.delta / outcome.sigma)}σ`;
  return `${signed(outcome.delta)}pp${inSigma}`;
}

/** v1 eval runs carry no wall time, so a ladder with any such run shows none rather than an undercount. */
function wallText(ladder: ArLadder): string {
  if (ladder.evals.length === 0 || ladder.evals.some((entry) => entry.wallS === undefined)) return "—";
  const seconds = ladder.evals.reduce((sum, entry) => sum + (entry.wallS ?? 0), 0);
  return `${Math.round(seconds / SECONDS_PER_MINUTE)}m`;
}
