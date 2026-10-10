import type { ReactNode } from "react";
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
import { GuessedCaption, STAGE_ORDER, TaskStageBadge, stageLabel } from "./TaskParts.js";

type Row = ConsoleCommands["work.tasks"]["result"]["tasks"][number];

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

function matches(row: Row, filters: Filters): boolean {
  const text = filters.q?.toLowerCase();
  return (
    (!filters.stage || row.stage === filters.stage) &&
    (!filters.initiative || row.slug === filters.initiative) &&
    (!filters.severity || row.severity === filters.severity) &&
    (!text || `${row.id} ${row.title}`.toLowerCase().includes(text))
  );
}

/** Open tasks across initiatives, grouped by derived stage; the filters live in the query string so a view is a link. */
export function TasksPage({ query }: { query?: string }): ReactNode {
  const tasks = useQuery("work.tasks");
  if (tasks.status === "loading") return <Spinner size="sm" label="Loading tasks" />;
  if (tasks.data === undefined) return <Alert status="error" message={`Could not load tasks: ${tasks.error.message}`} />;
  const { tasks: rows, evidence } = tasks.data;
  if (rows.length === 0) return <EmptyState title="No open tasks" description="No initiative has an open task." />;
  const filters = filtersOf(query);
  const shown = rows.filter((row) => matches(row, filters));
  return (
    <VStack gap={4}>
      {evidence.degraded.length > 0 ? <Alert status="warning" message={`Some stages lack evidence: ${evidence.degraded.join("; ")}`} /> : null}
      <FilterBar filters={filters} initiatives={[...new Set(rows.map((row) => row.slug))].sort()} />
      {shown.length === 0 ? <NoMatches /> : <StageGroups rows={shown} />}
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

function StageGroups({ rows }: { rows: readonly Row[] }): ReactNode {
  const groups = STAGE_ORDER.map((stage) => ({ stage, rows: rows.filter((row) => row.stage === stage) })).filter((group) => group.rows.length > 0);
  return (
    <VStack gap={6}>
      {groups.map((group) => (
        <Section key={group.stage} testID={`stage-group-${group.stage}`}>
          <SectionHeader title={`${stageLabel(group.stage)} (${group.rows.length})`} />
          <SectionContent>
            <StageTable rows={group.rows} />
          </SectionContent>
        </Section>
      ))}
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
