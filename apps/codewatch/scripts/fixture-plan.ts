// The calls a fixture records beyond the app's first paint: the table cases, a drill-down, and a growth timeline.
import type { SnapshotInfo } from "@titan-design/code-read";
import type { JsonEnvelope } from "@titan-design/rpc-protocol";
import type { PlannedCall } from "../server/plan.js";
import { CALLS, NO_FILTERS, childMetrics, isStoredKind, type FindingFilters, type SortKey } from "../src/data/calls.js";
import { PAGE_SIZE } from "../src/data/page-size.js";

/** Every sort key but the default, which first paint already recorded. */
const SORTS: SortKey[] = ["excess", "value", "path", "rule"];

/** A severity the check rules never emit, so the fixture also holds an honest filtered-empty answer. */
const ABSENT_SEVERITY = "info";

const TOP_VALUES = 2;

/** The contract's cap on `snapshot.list`, so one call covers a fixture of any length. */
const SNAPSHOT_LIST_MAX = 500;

export interface FindingsPage {
  rows: Array<{ id: string; node: { id: string; kind: string; name: string } }>;
  total: number;
  facets?: Record<string, Record<string, number>>;
}

export function read<T>(envelope: JsonEnvelope<unknown>): T | null {
  return envelope.ok ? (envelope.data as T) : null;
}

function findingsPage(snapshot: number, filters: Partial<FindingFilters>, sort: SortKey, offset: number): PlannedCall {
  return { command: "findings.list", args: CALLS.findingsPage(snapshot, { ...NO_FILTERS, ...filters }, sort, offset) };
}

function topValues(facet: Record<string, number> | undefined, count: number): string[] {
  return Object.entries(facet ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([value]) => value);
}

/** The sorts, the second page, one page per leading rule and severity, and a filter no row matches. */
export function tableCalls(snapshot: number, counts: FindingsPage | null): PlannedCall[] {
  const facets = counts?.facets ?? {};
  const calls = SORTS.map((sort) => findingsPage(snapshot, {}, sort, 0));
  if ((counts?.total ?? 0) > PAGE_SIZE) calls.push(findingsPage(snapshot, {}, "severity", PAGE_SIZE));
  for (const rule of topValues(facets.rule, TOP_VALUES)) calls.push(findingsPage(snapshot, { rule: [rule] }, "severity", 0));
  for (const severity of topValues(facets.severity, TOP_VALUES)) calls.push(findingsPage(snapshot, { severity: [severity] }, "severity", 0));
  calls.push(findingsPage(snapshot, { severity: [ABSENT_SEVERITY] }, "severity", 0));
  return calls;
}

function parentOf(id: string): string {
  const cut = id.lastIndexOf("/", id.length - 2);
  return cut < 0 ? "" : id.slice(0, cut + 1);
}

/** One node page's calls, exactly as `NodePage` sends them; only a stored node has neighbours. */
function nodePageCalls(snapshot: number, id: string, kind: string): PlannedCall[] {
  const calls: PlannedCall[] = [
    { command: "node.get", args: CALLS.node(snapshot, id) },
    { command: "hierarchy.get", args: CALLS.nodeTree(snapshot, id, childMetrics(kind)) },
    { command: "findings.list", args: CALLS.nodeFindings(snapshot, id) },
  ];
  if (isStoredKind(kind)) calls.push({ command: "node.neighbors", args: CALLS.nodeNeighbors(snapshot, id) });
  return calls;
}

/** The node page for the worst finding's file, its directory, and the repo, plus one search. */
export function drillCalls(snapshot: number, page: FindingsPage | null): PlannedCall[] {
  const worst = page?.rows[0]?.node;
  if (!worst) return nodePageCalls(snapshot, "", "directory");
  const directory = parentOf(worst.id);
  return [
    ...nodePageCalls(snapshot, worst.id, worst.kind),
    ...nodePageCalls(snapshot, directory, "directory"),
    ...nodePageCalls(snapshot, "", "directory"),
    { command: "node.resolve", args: CALLS.search(snapshot, worst.name) },
  ];
}

/**
 * code-read's contract has no timeline command, so a metric's history is recorded as
 * `snapshot.list` plus one `node.get` per node per snapshot: one point each, oldest to newest.
 */
export function timelineCalls(snapshots: readonly SnapshotInfo[], nodeIds: readonly string[]): PlannedCall[] {
  // Both the default call and the explicit one, so a consumer that knows nothing about the fixture still gets the list.
  const calls: PlannedCall[] = [
    { command: "snapshot.list", args: {} },
    { command: "snapshot.list", args: { limit: SNAPSHOT_LIST_MAX } },
  ];
  for (const id of nodeIds) {
    for (const info of [...snapshots].reverse()) calls.push({ command: "node.get", args: CALLS.node(info.id, id) });
  }
  return calls;
}
