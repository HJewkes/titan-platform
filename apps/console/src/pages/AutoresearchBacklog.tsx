import type { ReactNode } from "react";
import {
  Accordion,
  AccordionButton,
  AccordionItem,
  AccordionPanel,
  DataRow,
  EmptyState,
  HStack,
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
  Typography,
} from "@titan-design/react-ui";
import type { ArIdea, ArRound, ArRunView } from "../../server/autoresearch-view.js";
import { shortId } from "./autoresearch-format.js";

interface Quota {
  tone: PillTone;
  text: string;
  /** The planner's own words, which can run long, so they wrap as text beside the pill. */
  reason?: string;
}

/** Design §1.2: the planner queue after the newest round's picks, highest priority first, under its quota strip. */
export function AutoresearchBacklog({ run }: { run: ArRunView }): ReactNode {
  const round = run.rounds.at(-1);
  if (round === undefined) return null;
  const previous = run.rounds.at(-2);
  const queued = round.queue.filter((idea) => !round.selection.picks.includes(idea.id)).sort((a, b) => b.priority - a.priority);
  return (
    <Section testID="autoresearch-backlog">
      <SectionHeader title="Backlog" subtitle={`Round ${round.round}: ${queued.length} queued after the picks`} />
      <SectionContent>
        <DataRow label="Pool" value={<QuotaPill quota={poolQuota(round, run.settings.minPool)} />} />
        <DataRow label="Bold quota" value={<QuotaPill quota={boldQuota(round)} />} testID="autoresearch-quota-bold" />
        <DataRow label="Follow-up quota" value={<QuotaPill quota={followupQuota(round, previous)} />} />
        <RejectedAdds round={round} />
        {queued.length === 0 ? <EmptyState title="Every queued idea was picked this round" /> : <BacklogTable round={round} ideas={queued} />}
      </SectionContent>
    </Section>
  );
}

function QuotaPill({ quota }: { quota: Quota }): ReactNode {
  return (
    <HStack gap={2} align="center" justify="end" wrap>
      <Pill variant="subtle" size="xs" tone={quota.tone}>
        {quota.text}
      </Pill>
      {quota.reason === undefined ? null : <Typography variant="caption">{quota.reason}</Typography>}
    </HStack>
  );
}

const addedThisRound = (round: ArRound): ArIdea[] => round.queue.filter((idea) => idea.round === round.round && idea.source !== "requeue");

function poolQuota(round: ArRound, minPool: number): Quota {
  const size = round.queue.length;
  return { tone: size >= minPool ? "success" : "warning", text: `${size} queued, minimum ${minPool}` };
}

/** The planner owes a bold idea each round, or an `[EXEMPT]` reason; requeues are not its adds. */
function boldQuota(round: ArRound): Quota {
  if (addedThisRound(round).some((idea) => idea.bold)) return { tone: "success", text: "met" };
  if (round.exempt.bold !== undefined) return { tone: "info", text: "[EXEMPT]", reason: round.exempt.bold };
  return { tone: "error", text: "missed" };
}

/** A follow-up is owed only after a round that kept an idea. */
function followupQuota(round: ArRound, previous: ArRound | undefined): Quota {
  const keptLastRound = previous?.ladders.some((ladder) => ladder.outcome?.verdict === "kept") ?? false;
  if (!keptLastRound) return { tone: "neutral", text: "not due: nothing kept last round" };
  if (addedThisRound(round).some((idea) => idea.source === "followup")) return { tone: "success", text: "met" };
  if (round.exempt.followup !== undefined) return { tone: "info", text: "[EXEMPT]", reason: round.exempt.followup };
  return { tone: "error", text: "missed" };
}

function RejectedAdds({ round }: { round: ArRound }): ReactNode {
  if (round.rejected.length === 0) return <DataRow label="Rejected adds" value="none" />;
  return (
    <Accordion>
      <AccordionItem>
        <AccordionButton>{`${round.rejected.length} adds rejected`}</AccordionButton>
        <AccordionPanel>
          <HStack gap={2} wrap>
            {round.rejected.map((entry, index) => (
              <Pill key={`${entry.code}-${index}`} variant="outline" size="xs">
                {entry.code}
              </Pill>
            ))}
          </HStack>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}

function BacklogTable({ round, ideas }: { round: ArRound; ideas: readonly ArIdea[] }): ReactNode {
  return (
    <Table density="dense">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Priority</TableHeaderCell>
          <TableHeaderCell>Idea</TableHeaderCell>
          <TableHeaderCell>Cell</TableHeaderCell>
          <TableHeaderCell>Hypothesis</TableHeaderCell>
          <TableHeaderCell>Lineage</TableHeaderCell>
          <TableHeaderCell>Source</TableHeaderCell>
          <TableHeaderCell>Tags</TableHeaderCell>
          <TableHeaderCell>TS draw</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ideas.map((idea) => (
          <BacklogRow key={idea.id} round={round} idea={idea} />
        ))}
      </TableBody>
    </Table>
  );
}

function BacklogRow({ round, idea }: { round: ArRound; idea: ArIdea }): ReactNode {
  return (
    <TableRow testID={`autoresearch-backlog-${idea.id}`}>
      <TableCell>{idea.priority}</TableCell>
      <TableCell>{shortId(idea.id)}</TableCell>
      <TableCell>{idea.cell}</TableCell>
      <TableCell>{idea.hypothesis}</TableCell>
      <TableCell>{idea.parent === undefined ? shortId(idea.lineage) : `${shortId(idea.lineage)} ← ${shortId(idea.parent)}`}</TableCell>
      <TableCell>{idea.source}</TableCell>
      <TableCell>
        <IdeaTags idea={idea} />
      </TableCell>
      <TableCell>{drawText(round, idea.id)}</TableCell>
    </TableRow>
  );
}

function IdeaTags({ idea }: { idea: ArIdea }): ReactNode {
  return (
    <HStack gap={1} wrap>
      {idea.bold ? (
        <Pill variant="subtle" size="xs" tone="brand">
          bold
        </Pill>
      ) : null}
      {idea.differsFrom === undefined ? null : (
        <Pill variant="outline" size="xs">
          {`differs from ${idea.differsFrom}`}
        </Pill>
      )}
    </HStack>
  );
}

/** An idea the planner ranked into its top K that Thompson sampling then passed over is the §4.4 comparison made visible. */
function drawText(round: ArRound, id: string): string {
  const draw = round.selection.draws.find((entry) => entry.id === id)?.draw;
  const passedOver = round.selection.plannerTopK.includes(id) ? " · top K, not picked" : "";
  return draw === undefined ? `—${passedOver}` : `${draw.toFixed(2)}${passedOver}`;
}
