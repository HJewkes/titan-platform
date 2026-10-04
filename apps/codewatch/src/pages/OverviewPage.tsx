import type { ReactNode } from "react";
import { Alert, Card, HStack, Section, SectionContent, SectionHeader } from "@titan-design/react-ui";
import type { CodeReadCommandMap, MetricDescriptor } from "@titan-design/code-read/query";
import { DataTable, type Column } from "../components/DataTable.js";
import { Note, QueryView } from "../components/QueryView.js";
import { directionText, formatNumber, missingText } from "../components/format.js";
import { CALLS, overviewMetrics } from "../data/calls.js";
import { useQuery } from "../data/rpc.js";
import { href, nodeHref } from "../router.js";
import { useReport } from "../report-context.js";

type HierarchyRow = CodeReadCommandMap["hierarchy.get"]["result"]["nodes"][number];

export function OverviewPage(): ReactNode {
  const { describe } = useReport();
  const metrics = overviewMetrics(describe.metrics);
  return (
    <div className="flex flex-col gap-6">
      <Headline />
      <Section>
        <SectionHeader title="How the code is organised" subtitle="Top two directory levels, values rolled up from the files below" />
        <SectionContent>
          <DirectoryTree metrics={metrics} />
          <Note>A hierarchy map and a package dependency matrix replace this table when TD-32 and TD-35 land.</Note>
        </SectionContent>
      </Section>
    </div>
  );
}

function Headline(): ReactNode {
  const { snapshotId, describe } = useReport();
  const counts = useQuery("findings.list", CALLS.findingCounts(snapshotId));
  return (
    <HStack gap={4} wrap>
      <QueryView result={counts} label="finding counts">
        {(data) => (
          <>
            <Stat label="Findings" value={formatNumber(data.total)} link={href({ page: "priorities", query: { filters: {}, sort: "severity", offset: 0 } })} />
            {Object.entries(data.facets?.severity ?? {}).map(([severity, count]) => (
              <Stat key={severity} label={severity} value={formatNumber(count)}
                link={href({ page: "priorities", query: { filters: { severity: [severity] }, sort: "severity", offset: 0 } })} />
            ))}
          </>
        )}
      </QueryView>
      <Stat label="Rules checked" value={formatNumber(describe.rules.length)} />
      <Stat label="Metrics measured" value={formatNumber(describe.metrics.length)} />
    </HStack>
  );
}

function Stat({ label, value, link }: { label: string; value: string; link?: string }): ReactNode {
  const body = (
    <Card variant="outline" className="min-w-32 px-4 py-3">
      <span className="block text-xs uppercase text-text-secondary">{label}</span>
      <span className="block text-2xl font-semibold tabular-nums">{value}</span>
    </Card>
  );
  return link ? <a href={link} aria-label={`${label}: ${value}`}>{body}</a> : body;
}

function DirectoryTree({ metrics }: { metrics: readonly MetricDescriptor[] }): ReactNode {
  const { snapshotId } = useReport();
  const tree = useQuery("hierarchy.get", CALLS.overviewTree(snapshotId, metrics.map((m) => m.name)));
  return (
    <QueryView result={tree} label="the directory hierarchy" isEmpty={(d) => d.nodes.length <= 1}>
      {(data) => (
        <>
          {data.truncated && <Alert status="warning" message="The hierarchy was cut at the read API's row cap; deeper rows are missing." />}
          <DataTable
            caption="Directories by level"
            columns={directoryColumns(metrics)}
            rows={depthFirst(data.nodes.filter((n) => n.depth > 0))}
            rowKey={(row) => row.id}
            indent={(row) => row.depth - 1}
          />
        </>
      )}
    </QueryView>
  );
}

function directoryColumns(metrics: readonly MetricDescriptor[]): Column<HierarchyRow>[] {
  const name: Column<HierarchyRow> = {
    header: "Directory",
    render: (row) => <a className="text-text-link" href={nodeHref(row.id)}>{row.name}{row.kind === "directory" ? "/" : ""}</a>,
  };
  const values = metrics.map<Column<HierarchyRow>>((m) => ({
    header: m.name,
    hint: directionText(m.direction),
    align: "right",
    render: (row) => cellValue(row, m.name),
  }));
  return [name, ...values];
}

function cellValue(row: HierarchyRow, metric: string): ReactNode {
  const value = row.values[metric];
  if (value !== null && value !== undefined) return formatNumber(value);
  return <span className="text-text-tertiary">{missingText(row.missing?.[metric])}</span>;
}

/** hierarchy.get returns shallowest first; a table reads better with each directory's children under it. */
export function depthFirst(rows: readonly HierarchyRow[]): HierarchyRow[] {
  const children = new Map<string | null, HierarchyRow[]>();
  for (const row of rows) children.set(row.parentId, [...(children.get(row.parentId) ?? []), row]);
  const ids = new Set(rows.map((r) => r.id));
  const roots = rows.filter((r) => r.parentId === null || !ids.has(r.parentId));
  const out: HierarchyRow[] = [];
  const visit = (row: HierarchyRow): void => {
    out.push(row);
    for (const child of children.get(row.id) ?? []) visit(child);
  };
  roots.forEach(visit);
  return out;
}
