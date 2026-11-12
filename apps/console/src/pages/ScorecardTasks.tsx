import type { ReactNode } from "react";
import { Alert, Badge, BadgeText, Card, CardContent, EmptyState, HStack, Link, Section, SectionContent, SectionHeader, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Typography } from "@titan-design/react-ui";
import type { ScorecardTaskRow } from "../../server/scorecard-schema.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";
import { Spinner } from "../shell/Loading.js";
import { isInferredOrigin, NOT_MEASURED, usdText } from "./scorecard-format.js";
import { PHONE_TAP_ID_LINK } from "./phone.js";

const TASKS_MIN_WIDTH = 560;

/** The drill-down route's id: the task's initiative and id, split again at the last `/`. */
const scorecardTaskId = (row: Pick<ScorecardTaskRow, "initiative" | "taskId">): string => `${row.initiative}/${row.taskId}`;

/** Marks a value that rests on a heuristic's label, not a field recorded at the source. */
export function InferredBadge({ testID }: { testID?: string }): ReactNode {
  return (
    <Badge color="warning" variant="subtle" size="sm" {...(testID === undefined ? {} : { testID })}>
      <BadgeText>inferred</BadgeText>
    </Badge>
  );
}

/** A labelled value with its badge when the label was inferred rather than recorded at the source. */
export function Labelled({ value, origin, testID }: { value: string; origin: string | undefined; testID?: string }): ReactNode {
  return (
    <HStack gap={1} align="center" wrap>
      <Typography variant="body2">{value}</Typography>
      {isInferredOrigin(origin) ? <InferredBadge {...(testID === undefined ? {} : { testID })} /> : null}
    </HStack>
  );
}

function TaskTable({ rows }: { rows: readonly ScorecardTaskRow[] }): ReactNode {
  return (
    <Table density="dense" contentMinWidth={TASKS_MIN_WIDTH}>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Task</TableHeaderCell>
          <TableHeaderCell>Class</TableHeaderCell>
          <TableHeaderCell>Source</TableHeaderCell>
          <TableHeaderCell>Merged</TableHeaderCell>
          <TableHeaderCell align="right">Fix rounds</TableHeaderCell>
          <TableHeaderCell align="right">Cost</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TaskTableRow key={scorecardTaskId(row)} row={row} />
        ))}
      </TableBody>
    </Table>
  );
}

function TaskTableRow({ row }: { row: ScorecardTaskRow }): ReactNode {
  return (
    <TableRow testID={`scorecard-task-${row.taskId}`}>
      <TableCell>
        <Link color="primary" className={PHONE_TAP_ID_LINK} onPress={() => open({ view: "scorecard", id: scorecardTaskId(row) })}>
          {row.taskId}
        </Link>
      </TableCell>
      <TableCell>
        <Labelled value={row.classAtDispatch ?? NOT_MEASURED} origin={row.provenance["classAtDispatch"]} testID={`scorecard-task-${row.taskId}-class-inferred`} />
      </TableCell>
      <TableCell>
        <Labelled value={row.sourceAtDispatch ?? NOT_MEASURED} origin={row.provenance["sourceAtDispatch"]} />
      </TableCell>
      <TableCell>{row.mergedAt === null ? "no" : row.mergedAt.slice(0, 10)}</TableCell>
      <TableCell align="right">{String(row.fixRounds)}</TableCell>
      <TableCell align="right">{usdText(row.usd)}</TableCell>
    </TableRow>
  );
}

interface TaskListProps {
  testID: string;
  title: string;
  subtitle: string;
  args: { week?: string; inferred?: boolean };
  empty: string;
}

function TaskList({ testID, title, subtitle, args, empty }: TaskListProps): ReactNode {
  const tasks = useQuery("scorecard.tasks", args);
  const body =
    tasks.status === "loading" ? (
      <Spinner size="sm" label={`Loading ${title.toLowerCase()}`} />
    ) : tasks.data === undefined ? (
      <Alert status="error" message={`Could not load ${title.toLowerCase()}: ${tasks.error.message}`} />
    ) : tasks.data.rows.length === 0 ? (
      <EmptyState title={empty} />
    ) : (
      <TaskTable rows={tasks.data.rows} />
    );
  const total = tasks.data === undefined || tasks.data.total <= tasks.data.rows.length ? subtitle : `${subtitle} · newest ${tasks.data.rows.length} of ${tasks.data.total}`;
  return (
    <Section testID={testID}>
      <SectionHeader title={title} subtitle={total} />
      <SectionContent>{body}</SectionContent>
    </Section>
  );
}

export function WeekTasks({ week }: { week: string }): ReactNode {
  return <TaskList testID="scorecard-week-tasks" title="Tasks this week" subtitle="Tap a task for its row" args={{ week }} empty="No task was dispatched this week" />;
}

/** Read-only until the audit-set slice (S15) adds the one-tap confirm or correct. */
export function InferredReview(): ReactNode {
  return <TaskList testID="scorecard-inferred" title="Inferred labels to review" subtitle="Open tasks whose class or source was inferred" args={{ inferred: true }} empty="No open task rests on an inferred label" />;
}

export function AuditSetCard(): ReactNode {
  return (
    <Card testID="scorecard-audit-set">
      <CardContent>
        <Typography variant="subtitle2">Audit set</Typography>
        <Typography variant="body2">Agreement with the owner&apos;s labels: {NOT_MEASURED}.</Typography>
        <Typography variant="caption" color="secondary">
          The owner labels a fixed set of 40 tasks once, then 10 a week; labelling arrives with the audit-set slice.
        </Typography>
      </CardContent>
    </Card>
  );
}
