import type { ReactNode } from "react";
import {
  Caption,
  HStack,
  Pill,
  type PillTone,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Typography,
  VStack,
} from "@titan-design/react-ui";
import type { ArMove, ArReeval, ArRound, ArRunView } from "../../server/autoresearch-view.js";
import { RatchetMove } from "./AutoresearchRatchet.js";
import { reasonText, shortId, shortSha, signed } from "./autoresearch-format.js";

const DECISION_TONE: Record<ArReeval["decision"], PillTone> = { kept: "success", rejected: "error", requeued: "neutral" };

const MOVE_LABEL: Record<ArMove["kind"], string> = { ff: "fast-forward", merge: "merge", sync: "snapshot sync" };

/** Below this the re-evaluations scroll sideways rather than squeeze the reason into overlap. */
const REEVALS_MIN_WIDTH = 720;

/**
 * Design G13 (C-256 S5a): each step the round moved the ratchet, and each later winner measured again on the head the
 * round's first winner left. A round recorded before concurrent winners has neither and shows nothing here.
 */
export function AutoresearchRoundSettle({ run, round }: { run: ArRunView; round: ArRound }): ReactNode {
  if (round.moves.length === 0 && round.reevals.length === 0) return null;
  return (
    <VStack gap={2} testID={`autoresearch-settle-${round.round}`}>
      {round.moves.length === 0 ? null : <Moves repo={run.target.repo} moves={round.moves} />}
      {round.reevals.length === 0 ? null : <Reevals primary={run.target.metric.primary} reevals={round.reevals} />}
    </VStack>
  );
}

function Moves({ repo, moves }: { repo: string | undefined; moves: readonly ArMove[] }): ReactNode {
  return (
    <VStack gap={1} testID="autoresearch-moves">
      <Caption>Ratchet moves, in order</Caption>
      {moves.map((move, index) => (
        <HStack key={`${move.from}-${move.to}`} gap={2} align="center" wrap testID={`autoresearch-move-${index + 1}`}>
          <Pill variant="subtle" size="xs" tone={move.kind === "sync" ? "brand" : "neutral"}>
            {MOVE_LABEL[move.kind]}
          </Pill>
          <RatchetMove repo={repo} move={move} />
          {move.ideaId === undefined ? null : <Typography variant="body2">{shortId(move.ideaId)}</Typography>}
        </HStack>
      ))}
    </VStack>
  );
}

function Reevals({ primary, reevals }: { primary: string; reevals: readonly ArReeval[] }): ReactNode {
  return (
    <VStack gap={1}>
      <Caption>Later winners, measured again on the new head</Caption>
      <Table density="dense" contentMinWidth={REEVALS_MIN_WIDTH} testID="autoresearch-reevals">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Idea</TableHeaderCell>
            <TableHeaderCell>Against</TableHeaderCell>
            <TableHeaderCell>Decision</TableHeaderCell>
            <TableHeaderCell>Reason</TableHeaderCell>
            <TableHeaderCell>{`Δ ${primary}`}</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {reevals.map((reeval) => (
            <ReevalRow key={reeval.ideaId} reeval={reeval} />
          ))}
        </TableBody>
      </Table>
    </VStack>
  );
}

function ReevalRow({ reeval }: { reeval: ArReeval }): ReactNode {
  return (
    <TableRow testID={`autoresearch-reeval-${reeval.ideaId}`}>
      <TableCell>{shortId(reeval.ideaId)}</TableCell>
      <TableCell>{shortSha(reeval.vs)}</TableCell>
      <TableCell>
        <Pill variant="subtle" size="xs" tone={DECISION_TONE[reeval.decision]}>
          {reeval.decision}
        </Pill>
      </TableCell>
      <TableCell>{reevalReason(reeval)}</TableCell>
      <TableCell>{reeval.delta === undefined ? "—" : `${signed(reeval.delta)}pp`}</TableCell>
    </TableRow>
  );
}

const reevalReason = ({ reason, conflict }: ArReeval): string =>
  conflict === undefined || conflict.length === 0 ? reasonText(reason) : `${reasonText(reason)} (${conflict.join(", ")})`;
