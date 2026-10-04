import type { ReactNode } from "react";
import { Button, ButtonText, HStack, Pill, Section, SectionContent, SectionHeader } from "@titan-design/react-ui";
import { ProvenanceKind, type Finding } from "@titan-design/code-read/query";
import { ProvenanceBadge, SeverityBadge } from "../components/badges.js";
import { DataTable, type Column } from "../components/DataTable.js";
import { Note, QueryView } from "../components/QueryView.js";
import { formatNumber } from "../components/format.js";
import { CALLS, type FindingFilters } from "../data/calls.js";
import { PAGE_SIZE } from "../data/page-size.js";
import { useQuery } from "../data/rpc.js";
import { FILTER_KEYS, SORT_KEYS, findingHref, href, nodeHref, type FilterKey, type PrioritiesQuery } from "../router.js";
import { useReport } from "../report-context.js";


const go = (query: PrioritiesQuery): void => {
  window.location.hash = href({ page: "priorities", query });
};

export function PrioritiesPage({ query }: { query: PrioritiesQuery }): ReactNode {
  return (
    <Section>
      <SectionHeader title="Priorities" subtitle="Every finding, most severe and furthest past its threshold first" />
      <SectionContent>
        <div className="flex gap-6">
          <aside className="w-56 shrink-0" aria-label="Filters">
            <Facets query={query} />
          </aside>
          <div className="min-w-0 flex-1">
            <SortBar query={query} />
            <FindingRows query={query} />
          </div>
        </div>
      </SectionContent>
    </Section>
  );
}

/** Counts come from an unfiltered call: findings.list counts only rows past every filter, which would hide the other choices. */
function Facets({ query }: { query: PrioritiesQuery }): ReactNode {
  const { snapshotId } = useReport();
  const all = useQuery("findings.list", CALLS.findingCounts(snapshotId));
  return (
    <QueryView result={all} label="filters" isEmpty={(d) => d.total === 0} empty={<Note>Nothing to filter.</Note>}>
      {(data) => (
        <div className="flex flex-col gap-4">
          {FILTER_KEYS.map((key) => (
            <FacetGroup key={key} name={key} counts={data.facets?.[key] ?? {}} query={query} />
          ))}
        </div>
      )}
    </QueryView>
  );
}

function FacetGroup({ name, counts, query }: { name: FilterKey; counts: Record<string, number>; query: PrioritiesQuery }): ReactNode {
  const selected = query.filters[name] ?? [];
  const toggle = (value: string): void => {
    const next = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
    go({ ...query, offset: 0, filters: { ...query.filters, [name]: next } });
  };
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="mb-1 text-xs uppercase text-text-secondary">{name}</legend>
      <HStack gap={1} wrap>
        {Object.entries(counts).map(([value, count]) => (
          <Pill key={value} size="sm" variant={selected.includes(value) ? "solid" : "outline"} onPress={() => toggle(value)}
            accessibilityRole="checkbox" accessibilityState={{ checked: selected.includes(value) }}>
            {`${value} ${count}`}
          </Pill>
        ))}
      </HStack>
    </fieldset>
  );
}

function SortBar({ query }: { query: PrioritiesQuery }): ReactNode {
  return (
    <HStack gap={2} align="center" className="mb-2">
      <span className="text-xs text-text-secondary">Sort by</span>
      {SORT_KEYS.map((sort) => (
        <Button key={sort} size="sm" variant={sort === query.sort ? "solid" : "ghost"} onPress={() => go({ ...query, sort, offset: 0 })}>
          <ButtonText>{sort}</ButtonText>
        </Button>
      ))}
    </HStack>
  );
}

function FindingRows({ query }: { query: PrioritiesQuery }): ReactNode {
  const { snapshotId } = useReport();
  const page = useQuery("findings.list", CALLS.findingsPage(snapshotId, filterArgs(query), query.sort, query.offset));
  return (
    <QueryView result={page} label="findings" isEmpty={(d) => d.total === 0} empty={<NoFindings query={query} />}>
      {(data) => (
        <>
          <DataTable caption="Findings" columns={FINDING_COLUMNS} rows={data.rows} rowKey={(row) => row.id} />
          <Pager query={query} total={data.total} shown={data.rows.length} />
        </>
      )}
    </QueryView>
  );
}

/** URL values are plain strings; provenance is an enum, so an unknown value is dropped rather than sent as a DATAERR. */
function filterArgs({ filters }: PrioritiesQuery): FindingFilters {
  const provenance = (filters.provenance ?? []).flatMap((v) => {
    const parsed = ProvenanceKind.safeParse(v);
    return parsed.success ? [parsed.data] : [];
  });
  return { rule: filters.rule ?? [], severity: filters.severity ?? [], kind: filters.kind ?? [], provenance };
}

function NoFindings({ query }: { query: PrioritiesQuery }): ReactNode {
  const filtered = Object.values(query.filters).some((v) => v && v.length > 0);
  if (filtered) return <Note>No findings match these filters.</Note>;
  return <Note>No findings: every rule passes on this snapshot. Rules with stricter thresholds would surface more.</Note>;
}

function Pager({ query, total, shown }: { query: PrioritiesQuery; total: number; shown: number }): ReactNode {
  const from = total === 0 ? 0 : query.offset + 1;
  return (
    <HStack gap={2} align="center" className="mt-3">
      <Button size="sm" variant="outline" isDisabled={query.offset === 0} onPress={() => go({ ...query, offset: Math.max(0, query.offset - PAGE_SIZE) })}>
        <ButtonText>Previous</ButtonText>
      </Button>
      <span className="text-sm text-text-secondary">{`${from} to ${query.offset + shown} of ${total}`}</span>
      <Button size="sm" variant="outline" isDisabled={query.offset + shown >= total} onPress={() => go({ ...query, offset: query.offset + PAGE_SIZE })}>
        <ButtonText>Next</ButtonText>
      </Button>
    </HStack>
  );
}

const FINDING_COLUMNS: Column<Finding>[] = [
  { header: "Severity", render: (f) => <SeverityBadge severity={f.severity} /> },
  { header: "Finding", render: (f) => <a className="text-text-link" href={findingHref(f.id)}>{f.message}</a> },
  { header: "Where", render: (f) => <a className="text-text-link" href={nodeHref(f.node.id)}>{f.node.path || f.node.id}</a> },
  { header: "Rule", render: (f) => f.rule },
  { header: "Past threshold", hint: "value / threshold", align: "right", render: (f) => (f.excess === null ? "n/a" : `${formatNumber(f.excess)}x`) },
  { header: "Source", render: (f) => <ProvenanceBadge kind={f.provenance.kind} /> },
];
