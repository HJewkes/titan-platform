import type { Finding } from "./contract-findings.js";
import type { ModelFinding, ModelRule, ReadModel } from "./model.js";
import type { NodeRef } from "./schemas.js";
import { toRef } from "./tree.js";

export type FindingSort = "severity" | "excess" | "value" | "path" | "rule";
export type SortOrder = "asc" | "desc";

const SEVERITY_RANK: Record<string, number> = { error: 2, warning: 1, info: 0 };
const CHECK_TOOL = "check";

/** A stored node's reference, or a bare one for an id the snapshot does not hold, so a finding never drops its node. */
export function refFor(model: ReadModel, id: string): NodeRef {
  const node = model.nodeById.get(id);
  return node ? toRef(node) : { id, kind: "unknown", name: id, path: id };
}

/** Larger is worse for every rule: value over threshold for a maximum, threshold over value for a minimum. */
export function excessOf(ruleType: string | undefined, value?: number, threshold?: number): number | null {
  if (value === undefined || threshold === undefined) return null;
  if (ruleType === "metric-min") return value > 0 ? threshold / value : null;
  return threshold > 0 ? value / threshold : null;
}

function toFinding(model: ReadModel, f: ModelFinding, rules: ReadonlyMap<string, ModelRule>): Finding {
  const out: Finding = {
    id: f.id,
    snapshotId: model.snapshot.id,
    rule: f.rule,
    tool: CHECK_TOOL,
    severity: f.severity,
    node: refFor(model, f.nodeId),
    excess: excessOf(rules.get(f.rule)?.type, f.value, f.threshold),
    message: f.message,
    provenance: { kind: "derived", source: `${CHECK_TOOL}/${f.rule}` },
  };
  if (f.destinationId !== undefined) out.destination = refFor(model, f.destinationId);
  if (f.ranges?.[0]) out.range = f.ranges[0];
  if (f.metric !== undefined) out.metric = f.metric;
  if (f.value !== undefined) out.value = f.value;
  if (f.threshold !== undefined) out.threshold = f.threshold;
  return out;
}

const rowsByModel = new WeakMap<ReadModel, readonly Finding[]>();

/** Every finding of a snapshot as a contract row, built once per model. */
export function findingsFor(model: ReadModel): readonly Finding[] {
  let rows = rowsByModel.get(model);
  if (!rows) {
    const rules = new Map(model.rules.map((r) => [r.id, r]));
    rowsByModel.set(model, (rows = model.findings.map((f) => toFinding(model, f, rules))));
  }
  return rows;
}

function statusAgainst(current: Finding, before: Finding | undefined): Finding["status"] {
  if (!before) return "new";
  if (current.excess === null || before.excess === null || current.excess === before.excess) return "carryover";
  return current.excess > before.excess ? "worsened" : "improved";
}

// Matched by id only: following renames through the alias chain is TP-187's identity work.
/** The current rows with a status against the baseline, then the baseline's rows that no longer occur, as "resolved". */
export function withStatus(current: readonly Finding[], baseline: readonly Finding[]): Finding[] {
  const before = new Map(baseline.map((f) => [f.id, f]));
  const now = new Set(current.map((f) => f.id));
  const rows = current.map((f) => ({ ...f, status: statusAgainst(f, before.get(f.id)) }));
  for (const f of baseline) if (!now.has(f.id)) rows.push({ ...f, status: "resolved" });
  return rows;
}

const severityRank = (f: Finding): number => SEVERITY_RANK[f.severity] ?? -1;
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Nulls sort last whatever the direction, so an unmeasured row never heads a page. */
function byNullable(a: number | null | undefined, b: number | null | undefined, sign: number): number {
  const [x, y] = [a ?? null, b ?? null];
  if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
  return sign * (x - y);
}

type Compare = (a: Finding, b: Finding) => number;

const PRIMARY: Record<FindingSort, (sign: number) => Compare> = {
  severity: (sign) => (a, b) => sign * (severityRank(a) - severityRank(b)),
  excess: (sign) => (a, b) => byNullable(a.excess, b.excess, sign),
  value: (sign) => (a, b) => byNullable(a.value, b.value, sign),
  path: (sign) => (a, b) => sign * byText(a.node.path, b.node.path),
  rule: (sign) => (a, b) => sign * byText(a.rule, b.rule),
};

// Fixed whatever the sort: worst first, then by place, ending on the unique id so every page boundary is stable.
const TIES: readonly Compare[] = [
  PRIMARY.severity(-1),
  PRIMARY.excess(-1),
  PRIMARY.path(1),
  PRIMARY.rule(1),
  (a, b) => byText(a.id, b.id),
];

/** A total order: `order` flips the primary key only; ties always break the same way. */
export function compareFindings(sort: FindingSort, order: SortOrder): Compare {
  const chain = [PRIMARY[sort](order === "asc" ? 1 : -1), ...TIES];
  return (a, b) => {
    for (const compare of chain) {
      const c = compare(a, b);
      if (c !== 0) return c;
    }
    return 0;
  };
}
