import { useRef, useState, type ReactNode } from "react";
import {
  Alert,
  Button,
  ButtonText,
  EmptyState,
  HStack,
  Input,
  Link,
  Section,
  SectionContent,
  SectionHeader,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Typography,
  VStack,
} from "@titan-design/react-ui";
import type { QueryResult } from "@titan-design/react-app";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";
import { useMediaQuery } from "./FramePins.js";
import { GuessedCaption, STAGE_ORDER, TaskStageBadge, stageLabel } from "./TaskParts.js";

type TasksResult = ConsoleCommands["work.tasks"]["result"];
type TasksArgs = ConsoleCommands["work.tasks"]["args"];
type Row = TasksResult["tasks"][number];
type Stage = Row["stage"];

const FILTER_KEYS = ["stage", "initiative", "severity", "q"] as const;
type Filters = Partial<Record<(typeof FILTER_KEYS)[number], string>>;

const SEVERITIES = ["critical", "high", "medium", "low"];

function filtersOf(query: string | undefined): Filters {
  const params = new URLSearchParams(query ?? "");
  return Object.fromEntries(FILTER_KEYS.flatMap((key) => (params.get(key) ? [[key, params.get(key)!]] : [])));
}

function queryOf(filters: Filters): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  return params.toString();
}

function setFilters(filters: Filters): void {
  const query = queryOf(filters);
  open({ view: "tasks", ...(query ? { query } : {}) });
}

const isStage = (value: string | undefined): value is Stage => STAGE_ORDER.some((stage) => stage === value);

/** The server filters, so the per-stage cap never hides a row a filter would show; an unknown stage in the link is dropped. */
function argsOf({ stage, initiative, severity, q }: Filters): TasksArgs {
  return { ...(isStage(stage) ? { stage } : {}), ...(initiative ? { initiative } : {}), ...(severity ? { severity } : {}), ...(q ? { q } : {}) };
}

/** Open tasks of the selected initiative, or every one, grouped by derived stage a page at a time; the filters live in the query string so a view is a link. */
export function TasksPage({ query }: { query?: string }): ReactNode {
  const filters = filtersOf(query);
  const tasks = useQuery("work.tasks", argsOf(filters));
  // Each filter is a new read, so the bar keeps the last initiatives it saw instead of unmounting while one loads.
  const initiatives = useRef<readonly string[]>([]);
  if (tasks.data !== undefined) initiatives.current = tasks.data.initiatives;
  if (tasks.data?.initiatives.length === 0) return <EmptyState title="No open tasks" description="No initiative has an open task." />;
  return (
    <VStack gap={4}>
      {tasks.data && tasks.data.evidence.degraded.length > 0 ? <Alert status="warning" message={`Some stages lack evidence: ${tasks.data.evidence.degraded.join("; ")}`} /> : null}
      <FilterBar filters={filters} initiatives={initiatives.current} />
      <TasksBody key={queryOf(filters)} args={argsOf(filters)} tasks={tasks} />
    </VStack>
  );
}

function TasksBody({ args, tasks }: { args: TasksArgs; tasks: QueryResult<TasksResult> }): ReactNode {
  if (tasks.status === "loading") return <TasksSkeleton />;
  if (tasks.data === undefined) return <Alert status="error" message={`Could not load tasks: ${tasks.error.message}`} />;
  return tasks.data.tasks.length === 0 ? <NoMatches /> : <TaskPages args={args} shown={[]} page={tasks.data} />;
}

/** Rows stand in for the board while the first page loads, so a slow phone shows the page's shape at once. */
function TasksSkeleton(): ReactNode {
  return (
    <VStack gap={2}>
      <Skeleton variant="text" width="40%" height={24} accessibilityLabel="Loading tasks" />
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} variant="rounded" width="100%" height={44} />
      ))}
    </VStack>
  );
}

/** The rows shown so far plus one more page; "Load more" hands them all to the reader of the page after it. */
function TaskPages({ args, shown, page }: { args: TasksArgs; shown: readonly Row[]; page: TasksResult }): ReactNode {
  const [more, setMore] = useState(false);
  const rows = [...shown, ...page.tasks];
  const next = page.nextCursor;
  if (more && next !== null) return <NextPage args={args} cursor={next} shown={rows} counts={page.counts} />;
  const total = Object.values(page.counts).reduce((sum, count) => sum + count, 0);
  return (
    <VStack gap={4}>
      <StageGroups rows={rows} counts={page.counts} />
      {next === null ? null : (
        <HStack>
          <Button variant="outline" size="sm" onPress={() => setMore(true)}>
            <ButtonText>{`Load more (${rows.length} of ${total} shown)`}</ButtonText>
          </Button>
        </HStack>
      )}
    </VStack>
  );
}

function NextPage({ args, cursor, shown, counts }: { args: TasksArgs; cursor: string; shown: readonly Row[]; counts: TasksResult["counts"] }): ReactNode {
  const page = useQuery("work.tasks", { ...args, cursor });
  if (page.data !== undefined) return <TaskPages args={args} shown={shown} page={page.data} />;
  return (
    <VStack gap={4}>
      <StageGroups rows={shown} counts={counts} />
      {page.status === "loading" ? <Skeleton variant="rounded" width="100%" height={44} accessibilityLabel="Loading more tasks" /> : <Alert status="error" message={`Could not load more tasks: ${page.error.message}`} />}
    </VStack>
  );
}

function NoMatches(): ReactNode {
  return (
    <EmptyState
      title="No tasks match these filters"
      action={
        <Button variant="outline" onPress={() => setFilters({})}>
          <ButtonText>Clear filters</ButtonText>
        </Button>
      }
    />
  );
}

const optionsOf = (values: readonly string[]) => values.map((value) => ({ value, label: value }));

const STAGE_OPTIONS = STAGE_ORDER.map((stage) => ({ value: stage, label: stageLabel(stage) }));

function FilterBar({ filters, initiatives }: { filters: Filters; initiatives: readonly string[] }): ReactNode {
  const change = (key: keyof Filters) => (value: string | null) => setFilters({ ...filters, [key]: value ?? undefined });
  return (
    <HStack gap={3} align="center" wrap>
      <Select<string> placeholder="Any stage" value={filters.stage ?? null} onChange={change("stage")} options={STAGE_OPTIONS} />
      <Select placeholder="Any initiative" value={filters.initiative ?? null} onChange={change("initiative")} options={optionsOf(initiatives)} />
      <Select placeholder="Any severity" value={filters.severity ?? null} onChange={change("severity")} options={optionsOf(SEVERITIES)} />
      <Input placeholder="Filter by id or title" accessibilityLabel="Filter by id or title" value={filters.q ?? ""} onChangeText={(text) => change("q")(text || null)} />
    </HStack>
  );
}

function StageGroups({ rows, counts }: { rows: readonly Row[]; counts: TasksResult["counts"] }): ReactNode {
  const groups = STAGE_ORDER.map((stage) => ({ stage, rows: rows.filter((row) => row.stage === stage) })).filter((group) => group.rows.length > 0);
  return (
    <VStack gap={6}>
      {groups.map((group) => (
        <Section key={group.stage} testID={`stage-group-${group.stage}`}>
          <SectionHeader title={`${stageLabel(group.stage)} (${counts[group.stage]})`} />
          <SectionContent>
            {group.rows.length < counts[group.stage] ? (
              <Typography variant="caption" color="secondary">{`Showing ${group.rows.length} of ${counts[group.stage]} by priority; load more or filter to see the rest.`}</Typography>
            ) : null}
            <StageRows rows={group.rows} />
          </SectionContent>
        </Section>
      ))}
    </VStack>
  );
}

/** Tailwind's `md` breakpoint: below it the five columns squeeze the initiative over the title. */
export const BELOW_MD = "(max-width: 767px)";

/** One tree, not a CSS swap of two, so a 50-row page renders its rows once. */
function StageRows({ rows }: { rows: readonly Row[] }): ReactNode {
  return useMediaQuery(BELOW_MD) ? <StageCards rows={rows} /> : <StageTable rows={rows} />;
}

function StageCards({ rows }: { rows: readonly Row[] }): ReactNode {
  return (
    <VStack>
      {rows.map((row) => (
        <StageCard key={row.id} row={row} />
      ))}
    </VStack>
  );
}

/** A phone tap needs a 44px target, more than the id's line of text gives it. */
const TAP_TARGET = "inline-flex min-h-11 min-w-11 items-center";

function StageCard({ row }: { row: Row }): ReactNode {
  return (
    <VStack gap={1} className="min-w-0 border-b border-divider px-inset-md py-inset-sm" testID={`task-card-${row.id}`}>
      <HStack gap={2} align="center" justify="between">
        <Link color="primary" className={TAP_TARGET} onPress={() => open({ view: "tasks", id: row.id })}>
          {row.id}
        </Link>
        <TaskStageBadge stage={row.stage} />
      </HStack>
      <Typography variant="body1" className="break-words">
        {row.title}
      </Typography>
      {row.stageGuessed ? <GuessedCaption /> : <Typography variant="caption" color="secondary" className="break-words">{row.stageReason}</Typography>}
      <Typography variant="caption" color="secondary" className="break-words">{`${row.slug} · ${row.severity ?? "no severity"}`}</Typography>
    </VStack>
  );
}

/** Stands in for react-ui's `TaskTable` with stage rows, which only the unreleased react-ui 0.22.0 exports. */
function StageTable({ rows }: { rows: readonly Row[] }): ReactNode {
  return (
    <Table density="dense">
      <TableHeader>
        <TableRow>
          <TableHeaderCell width={110}>Task</TableHeaderCell>
          <TableHeaderCell>Title and stage reason</TableHeaderCell>
          <TableHeaderCell width={160}>Initiative</TableHeaderCell>
          <TableHeaderCell width={100}>Severity</TableHeaderCell>
          <TableHeaderCell width={120}>Stage</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <StageRow key={row.id} row={row} />
        ))}
      </TableBody>
    </Table>
  );
}

function StageRow({ row }: { row: Row }): ReactNode {
  return (
    <TableRow testID={`task-row-${row.id}`}>
      <TableCell width={110}>
        <Link color="primary" onPress={() => open({ view: "tasks", id: row.id })}>
          {row.id}
        </Link>
      </TableCell>
      <TableCell>
        <VStack gap={1}>
          <Typography variant="body1">{row.title}</Typography>
          {row.stageGuessed ? <GuessedCaption /> : <Typography variant="caption" color="secondary">{row.stageReason}</Typography>}
        </VStack>
      </TableCell>
      <TableCell width={160}>{row.slug}</TableCell>
      <TableCell width={100}>{row.severity ?? "–"}</TableCell>
      <TableCell width={120}>
        <TaskStageBadge stage={row.stage} />
      </TableCell>
    </TableRow>
  );
}
