import type { ReactNode } from "react";
import { Badge, BadgeText, BreadcrumbItem, Breadcrumbs, HStack, Section, SectionContent, SectionHeader } from "@titan-design/react-ui";
import type { CodeReadCommandMap } from "@titan-design/code-read/query";
import { SeverityBadge } from "../components/badges.js";
import { DataTable, type Column } from "../components/DataTable.js";
import { Note, QueryView } from "../components/QueryView.js";
import { directionText, formatNumber, missingText, rankText } from "../components/format.js";
import { useQuery } from "../data/rpc.js";
import { findingHref, nodeHref } from "../router.js";
import { useReport } from "../report-context.js";
import { depthFirst } from "./OverviewPage.js";

type NodeResult = CodeReadCommandMap["node.get"]["result"];
type NodeMetric = NodeResult["metrics"][number];
type Neighbor = CodeReadCommandMap["node.neighbors"]["result"]["inbound"][number];

/** Kinds code-graph stores; directories and the repo are synthesized, so they have no edges of their own. */
const STORED_KINDS = new Set(["file", "symbol", "module", "external"]);
const LIST_LIMIT = 10;

/** One template for every level: repo, directory, file, and symbol. */
export function NodePage({ id }: { id: string }): ReactNode {
  const { snapshotId } = useReport();
  const node = useQuery("node.get", { snapshot: snapshotId, id });
  return (
    <QueryView result={node} label={`node ${id || "(repo)"}`}>
      {(data) => (
        <div className="flex flex-col gap-6">
          <NodeHeader data={data} />
          <MetricsSection metrics={data.metrics} />
          <ChildrenSection id={id} kind={data.node.kind} />
          <FindingsSection id={id} />
          {STORED_KINDS.has(data.node.kind) ? <NeighborsSection id={id} /> : <Note>Dependencies between directories arrive with the package matrix (TD-35).</Note>}
          <SimilarNote />
        </div>
      )}
    </QueryView>
  );
}

function NodeHeader({ data }: { data: NodeResult }): ReactNode {
  const { node } = data;
  return (
    <header>
      <Breadcrumbs>
        {data.ancestors.map((a) => (
          <BreadcrumbItem key={a.id} href={nodeHref(a.id)}>{a.id === "" ? "repo" : a.name}</BreadcrumbItem>
        ))}
        <BreadcrumbItem isCurrentPage>{node.id === "" ? "repo" : node.name}</BreadcrumbItem>
      </Breadcrumbs>
      <HStack gap={2} align="center" className="mt-2">
        <h2 className="m-0 text-lg font-semibold">{headingOf(node)}</h2>
        <Badge size="sm" variant="outline"><BadgeText>{node.kind}</BadgeText></Badge>
        {node.role && <Badge size="sm" variant="subtle"><BadgeText>{node.role}</BadgeText></Badge>}
      </HStack>
      {node.signature && <pre className="mt-2 font-mono text-xs text-text-secondary">{node.signature}</pre>}
    </header>
  );
}

function headingOf(node: NodeResult["node"]): string {
  if (node.id === "") return "Repository";
  return node.kind === "symbol" ? `${node.name} in ${node.path}` : node.path || node.name;
}

const METRIC_COLUMNS: Column<NodeMetric>[] = [
  { header: "Metric", render: (m) => <span title={directionText(m.direction)}>{m.name}</span> },
  { header: "Value", align: "right", render: (m) => (m.value === null ? <span className="text-text-tertiary">{missingText(m.missing)}</span> : formatNumber(m.value)) },
  { header: "Percentile", hint: "share of same-kind nodes at or below", align: "right", render: (m) => formatNumber(m.percentile) },
  { header: "Sibling median", align: "right", render: (m) => formatNumber(m.siblingMedian) },
  { header: "Among siblings", render: (m) => rankText(m) },
  { header: "Direction", render: (m) => directionText(m.direction) },
];

function MetricsSection({ metrics }: { metrics: readonly NodeMetric[] }): ReactNode {
  const shown = metrics.filter((m) => m.value !== null || m.missing === "not-measured");
  const hidden = metrics.filter((m) => !shown.includes(m));
  return (
    <Section>
      <SectionHeader title="Metrics" subtitle="Measured by code-graph; ranks count the largest value first, whichever way is worse" />
      <SectionContent>
        {shown.length === 0 ? <Note>No metric has a value at this level.</Note> : <DataTable caption="Metrics" columns={METRIC_COLUMNS} rows={shown} rowKey={(m) => m.name} />}
        {groupByReason(hidden).map(([reason, names]) => <Note key={reason}>{`${capitalise(missingText(reason))}: ${names.join(", ")}.`}</Note>)}
      </SectionContent>
    </Section>
  );
}

function groupByReason(metrics: readonly NodeMetric[]): Array<[string, string[]]> {
  const groups = new Map<string, string[]>();
  for (const m of metrics) groups.set(m.missing ?? "", [...(groups.get(m.missing ?? "") ?? []), m.name]);
  return [...groups];
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

type Row = CodeReadCommandMap["hierarchy.get"]["result"]["nodes"][number];

function ChildrenSection({ id, kind }: { id: string; kind: string }): ReactNode {
  const { snapshotId } = useReport();
  const metrics = kind === "file" || kind === "symbol" ? ["symbol_cognitive", "symbol_cyclomatic"] : ["loc", "cognitive_sum"];
  const tree = useQuery("hierarchy.get", { snapshot: snapshotId, root: id, depth: 1, metrics, include_symbols: true });
  const columns: Column<Row>[] = [
    { header: "Name", render: (r) => <a className="text-text-link" href={nodeHref(r.id)}>{r.name}</a> },
    { header: "Kind", render: (r) => r.kind },
    ...metrics.map<Column<Row>>((m) => ({ header: m, align: "right", render: (r) => (r.values[m] == null ? missingText(r.missing?.[m]) : formatNumber(r.values[m])) })),
  ];
  return (
    <Section>
      <SectionHeader title="Contains" subtitle="One level down; TD-32's hierarchy navigation replaces this list" />
      <SectionContent>
        <QueryView result={tree} label="children" isEmpty={(d) => d.nodes.length <= 1} empty={<Note>Nothing below this node.</Note>}>
          {(data) => <DataTable caption="Children" columns={columns} rows={depthFirst(data.nodes.filter((n) => n.depth > 0))} rowKey={(r) => r.id} />}
        </QueryView>
      </SectionContent>
    </Section>
  );
}

function FindingsSection({ id }: { id: string }): ReactNode {
  const { snapshotId } = useReport();
  const findings = useQuery("findings.list", { snapshot: snapshotId, scope: id, limit: LIST_LIMIT });
  return (
    <Section>
      <SectionHeader title="Findings here and below" />
      <SectionContent>
        <QueryView result={findings} label="findings" isEmpty={(d) => d.total === 0} empty={<Note>No findings on this node or under it.</Note>}>
          {(data) => (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {data.rows.map((f) => (
                <li key={f.id} className="flex items-center gap-2 text-sm">
                  <SeverityBadge severity={f.severity} />
                  <a className="text-text-link" href={findingHref(f.id)}>{f.message}</a>
                </li>
              ))}
              {data.total > data.rows.length && <li><Note>{`and ${data.total - data.rows.length} more.`}</Note></li>}
            </ul>
          )}
        </QueryView>
      </SectionContent>
    </Section>
  );
}

function NeighborsSection({ id }: { id: string }): ReactNode {
  const { snapshotId } = useReport();
  const neighbors = useQuery("node.neighbors", { snapshot: snapshotId, id, limit: LIST_LIMIT });
  return (
    <Section>
      <SectionHeader title="Neighbours" subtitle="Heaviest edges first; the ego-graph drawing waits on a graph component" />
      <SectionContent>
        <QueryView result={neighbors} label="neighbours">
          {(data) => (
            <div className="grid grid-cols-2 gap-6">
              <NeighborList title="Used by" items={data.inbound} total={data.total.inbound} />
              <NeighborList title="Uses" items={data.outbound} total={data.total.outbound} />
            </div>
          )}
        </QueryView>
      </SectionContent>
    </Section>
  );
}

function NeighborList({ title, items, total }: { title: string; items: readonly Neighbor[]; total: number }): ReactNode {
  return (
    <div>
      <h3 className="m-0 mb-1 text-sm font-medium">{`${title} (${total})`}</h3>
      {items.length === 0 ? <Note>None.</Note> : (
        <ul className="m-0 list-none p-0 text-sm">
          {items.map((n) => (
            <li key={`${n.kind}:${n.node.id}`}>
              <a className="text-text-link" href={nodeHref(n.node.id)}>{n.node.path || n.node.id}</a>
              <span className="text-text-tertiary">{` ${n.kind}${n.weight === null ? "" : ` x${n.weight}`}`}</span>
            </li>
          ))}
          {total > items.length && <li><Note>{`and ${total - items.length} more.`}</Note></li>}
        </ul>
      )}
    </div>
  );
}

function SimilarNote(): ReactNode {
  const { describe } = useReport();
  if (describe.capabilities.embeddings) return null;
  return <Note>Similar code elsewhere: unavailable, because this index has no embeddings.</Note>;
}
