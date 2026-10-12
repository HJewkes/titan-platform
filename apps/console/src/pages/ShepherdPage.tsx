import type { ReactNode } from "react";
import {
  Alert,
  Badge,
  BadgeText,
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
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";

export type WatchRow = ConsoleCommands["shepherd.list"]["result"][number];
type WaitingGate = ConsoleCommands["shepherd.waiting"]["result"]["owner"][number];

const MINUTES_WIDTH = 96;
/** `all` can run large (TP-2563 plan R3), so the page asks only for live runs. */
const ACTIVE = { state: "active" } as const;

/** The detail route's id, `owner/repo#pr`; the last `#` splits it because a repo name holds none. */
export function prRef(repo: string, pr: number): string {
  return `${repo}#${pr}`;
}

/** Shepherd's live runs and the gates waiting on someone. Read-only: holds, releases and merges stay in titan-factory. */
export function ShepherdPage(): ReactNode {
  return (
    <VStack gap={6}>
      <WatchListSection />
      <WaitingSection />
    </VStack>
  );
}

function WatchListSection(): ReactNode {
  const list = useQuery("shepherd.list", ACTIVE);
  return (
    <Section>
      <SectionHeader title="Watch list" subtitle="Every shepherded PR whose run is active" />
      <SectionContent>
        {list.status === "loading" ? (
          <Spinner size="sm" label="Loading the watch list" />
        ) : list.data === undefined ? (
          <Alert status="error" message={`Could not load Shepherd's watch list: ${list.error.message}`} />
        ) : list.data.length === 0 ? (
          <EmptyState title="Shepherd watches no PR" />
        ) : (
          <WatchTable rows={list.data} />
        )}
      </SectionContent>
    </Section>
  );
}

function WatchTable({ rows }: { rows: readonly WatchRow[] }): ReactNode {
  return (
    <Table density="dense">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>PR</TableHeaderCell>
          <TableHeaderCell>Phase</TableHeaderCell>
          <TableHeaderCell>Stage</TableHeaderCell>
          <TableHeaderCell width={MINUTES_WIDTH} align="right">
            Minutes
          </TableHeaderCell>
          <TableHeaderCell>Next action</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <WatchTableRow key={row.runId} row={row} />
        ))}
      </TableBody>
    </Table>
  );
}

function WatchTableRow({ row }: { row: WatchRow }): ReactNode {
  const stage = stageOf(row);
  return (
    <TableRow testID={`shepherd-row-${row.runId}`}>
      <TableCell>
        <HStack gap={2} align="center" wrap>
          <PrLink row={row} />
          <RowBadges row={row} />
        </HStack>
      </TableCell>
      <TableCell>
        <Pill variant="subtle" size="xs">
          {row.phase}
        </Pill>
      </TableCell>
      <TableCell>{stage?.name ?? "–"}</TableCell>
      <TableCell width={MINUTES_WIDTH} align="right">
        {stage ? String(stage.minutes) : "–"}
      </TableCell>
      <TableCell>
        <Typography variant="body2">{row.nextAction}</Typography>
      </TableCell>
    </TableRow>
  );
}

/** A run still waiting for its PR has no number, so it has no timeline to open yet. */
function PrLink({ row }: { row: WatchRow }): ReactNode {
  if (row.pr === null) return <Typography variant="body2">{`${row.repo} (${row.branch})`}</Typography>;
  const ref = prRef(row.repo, row.pr);
  return (
    <Link color="primary" onPress={() => open({ view: "shepherd", id: ref })}>
      {ref}
    </Link>
  );
}

export function RowBadges({ row }: { row: WatchRow }): ReactNode {
  return (
    <>
      {row.held ? <ReasonBadge label="held" color="warning" reason={row.held.reason} /> : null}
      {row.stalled ? <ReasonBadge label="stalled" color="error" reason={row.stalled.reason} /> : null}
    </>
  );
}

function ReasonBadge({ label, color, reason }: { label: string; color: "warning" | "error"; reason: string }): ReactNode {
  return (
    <HStack gap={1} align="center">
      <Badge color={color} variant="subtle" size="sm">
        <BadgeText>{label}</BadgeText>
      </Badge>
      <Typography variant="caption" color="secondary">
        {reason}
      </Typography>
    </HStack>
  );
}

/** The console's schema passes `stage` through untyped, and rows older than the field lack it. */
export function stageOf(row: WatchRow): { name: string; minutes: number } | undefined {
  const stage = row["stage"];
  if (typeof stage !== "object" || stage === null) return undefined;
  const { name, minutes } = stage as Record<string, unknown>;
  return typeof name === "string" && typeof minutes === "number" ? { name, minutes } : undefined;
}

function WaitingSection(): ReactNode {
  const waiting = useQuery("shepherd.waiting");
  if (waiting.status === "loading") return <Spinner size="sm" label="Loading waiting gates" />;
  if (waiting.data === undefined) return <Alert status="error" message={`Could not load Shepherd's waiting gates: ${waiting.error.message}`} />;
  return (
    <>
      <GatesSection title="Waiting on you" subtitle="Owner gates, oldest first" gates={waiting.data.owner} empty="No owner gate is waiting" testID="shepherd-owner-gates" />
      <GatesSection title="Waiting on seats" subtitle="Seat gates, oldest first" gates={waiting.data.seat} empty="No seat gate is waiting" testID="shepherd-seat-gates" />
    </>
  );
}

interface GatesSectionProps {
  title: string;
  subtitle: string;
  gates: readonly WaitingGate[];
  empty: string;
  testID: string;
}

function GatesSection({ title, subtitle, gates, empty, testID }: GatesSectionProps): ReactNode {
  return (
    <Section testID={testID}>
      <SectionHeader title={title} subtitle={subtitle} />
      <SectionContent>{gates.length === 0 ? <EmptyState title={empty} /> : <GatesTable gates={gates} />}</SectionContent>
    </Section>
  );
}

function GatesTable({ gates }: { gates: readonly WaitingGate[] }): ReactNode {
  return (
    <Table density="dense">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>PR</TableHeaderCell>
          <TableHeaderCell>Gate</TableHeaderCell>
          <TableHeaderCell>Task</TableHeaderCell>
          <TableHeaderCell width={MINUTES_WIDTH} align="right">
            Hours
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {gates.map((gate) => (
          <TableRow key={gate.gateId} testID={`shepherd-gate-${gate.gateId}`}>
            <TableCell>{gate.pr === null ? gate.repo : prRef(gate.repo, gate.pr)}</TableCell>
            <TableCell>{gate.stepId}</TableCell>
            <TableCell>{gate.task}</TableCell>
            <TableCell width={MINUTES_WIDTH} align="right">
              {gate.ageHours.toFixed(1)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
