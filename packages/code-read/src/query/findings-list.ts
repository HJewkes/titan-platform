import { baselineFields, openBaseline } from "./baseline.js";
import type { Finding } from "./contract-findings.js";
import type { CommandArgs, CommandResult } from "./contract.js";
import { compareFindings, findingsFor, withStatus } from "./finding-rows.js";
import type { NodeRef } from "./schemas.js";
import { modelFor } from "./snapshot-ref.js";
import { invalidArgs, nodeNotFound, type ReadSource } from "./source.js";
import { REPO_ID, directoryId, treeFor, type TreeNode } from "./tree.js";

type ListArgs = CommandArgs<"findings.list">;
type ListResult = CommandResult<"findings.list">;

/** What a scope holds and how its findings split among its children. */
interface Scope {
  contains(ref: NodeRef): boolean;
  childOf(ref: NodeRef): string;
}

function childUnder(prefix: string, ref: NodeRef): string {
  if (ref.kind === "external" || !ref.path.startsWith(prefix)) return ref.id;
  const rest = ref.path.slice(prefix.length);
  const slash = rest.indexOf("/");
  return slash < 0 ? ref.path : directoryId(prefix + rest.slice(0, slash));
}

// A symbol's path is its declaring file, so a file scope holds its symbols' findings too.
function scopeOf(node: TreeNode): Scope {
  const { kind, id, path } = node.ref;
  if (kind === "repo") return { contains: () => true, childOf: (ref) => childUnder("", ref) };
  if (kind === "directory") {
    const prefix = `${path}/`;
    return { contains: (ref) => ref.path.startsWith(prefix), childOf: (ref) => childUnder(prefix, ref) };
  }
  if (kind === "file") return { contains: (ref) => ref.path === id, childOf: (ref) => ref.id };
  return { contains: (ref) => ref.id === id || ref.id.startsWith(`${id}.`), childOf: (ref) => ref.id };
}

type Filter = (f: Finding) => boolean;

function oneOf<T>(allowed: readonly T[], pick: (f: Finding) => T | undefined): Filter {
  if (allowed.length === 0) return () => true;
  const set = new Set(allowed);
  return (f) => {
    const value = pick(f);
    return value !== undefined && set.has(value);
  };
}

function filtersFor(args: ListArgs, scope: Scope): Filter[] {
  return [
    (f) => scope.contains(f.node),
    oneOf(args.rule, (f) => f.rule),
    oneOf(args.severity, (f) => f.severity),
    oneOf(args.tool, (f) => f.tool),
    oneOf(args.provenance, (f) => f.provenance.kind),
    oneOf(args.kind, (f) => f.node.kind),
    oneOf(args.status, (f) => f.status),
  ];
}

const FACETS: Record<string, (f: Finding, scope: Scope) => string | undefined> = {
  rule: (f) => f.rule,
  severity: (f) => f.severity,
  tool: (f) => f.tool,
  provenance: (f) => f.provenance.kind,
  kind: (f) => f.node.kind,
  child: (f, scope) => scope.childOf(f.node),
  status: (f) => f.status,
};

function sortedCounts(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Counts per facet over every kept row, so each facet's counts sum to `total`; `status` only with a baseline. */
function facetCounts(rows: readonly Finding[], scope: Scope, withBaseline: boolean): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [name, pick] of Object.entries(FACETS)) {
    if (name === "status" && !withBaseline) continue;
    const counts = new Map<string, number>();
    for (const f of rows) {
      const value = pick(f, scope) ?? "";
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    out[name] = sortedCounts(counts);
  }
  return out;
}

/** `findings.list`: a snapshot's findings, filtered, ordered by a total order, and cut to one page. */
export function listFindings(source: ReadSource, args: ListArgs): ListResult {
  const model = modelFor(source, args.snapshot);
  const baseline = openBaseline(source, args.baseline);
  if (args.status.length > 0 && !baseline) throw invalidArgs("status needs a baseline");
  const root = treeFor(model).byId.get(args.scope ?? REPO_ID);
  if (!root) throw nodeNotFound(args.scope ?? REPO_ID, model.snapshot.id);
  const scope = scopeOf(root);
  const all = baseline ? withStatus(findingsFor(model), findingsFor(baseline.model)) : findingsFor(model);
  const filters = filtersFor(args, scope);
  const kept = all.filter((f) => filters.every((keep) => keep(f))).sort(compareFindings(args.sort, args.order));
  const result: ListResult = {
    snapshotId: model.snapshot.id,
    ...baselineFields(model, baseline),
    rows: kept.slice(args.offset, args.offset + args.limit),
    total: kept.length,
  };
  if (args.facets) result.facets = facetCounts(kept, scope, baseline !== undefined);
  return result;
}
