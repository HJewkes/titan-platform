import type { GraphEdge, GraphNode } from "../types.js";
import { keepNode, lookupMetric, type ReportContext } from "./graph-report-sections.js";
import type { DeadModuleRow } from "./graph-report-types.js";

/**
 * Roles that seed reachability (and are never themselves "dead"): executable
 * entries (shebang-prefixed, e.g. the CLI), package barrels (re-export hubs),
 * tests, scripts, configs, and fixtures. Everything a repo actually runs is
 * reachable from these — with dynamic `import()` edges now captured (C-65), the
 * CLI's lazily-loaded command surface is reachable too, so live commands aren't
 * falsely flagged.
 */
const ENTRY_ROOT_ROLES = new Set([
  "entry",
  "barrel",
  "test",
  "script",
  "config",
  "fixture",
]);

/**
 * A file that is conventionally a bundler entry point even though nothing imports
 * it — a `main.{ts,tsx,js,jsx}` (Vite/CRA/webpack default, referenced from
 * `index.html`, not from code). Seeds reachability so a whole SPA under it isn't
 * flagged unreferenced. (`index.*` is already the `barrel` role.)
 */
const ENTRY_FILE_RE = /(?:^|\/)main\.[jt]sx?$/;

function isEntryRoot(node: GraphNode): boolean {
  return (
    node.kind === "file" &&
    ((node.role !== undefined && ENTRY_ROOT_ROLES.has(node.role)) ||
      ENTRY_FILE_RE.test(node.id))
  );
}

/**
 * Files unreachable from the entry roots by a forward BFS over `imports` /
 * `re-exports` edges — "no importer found given configured entry points" (C-65),
 * NOT proven dead. Catches transitively-dead chains, not just fan-in-0 files.
 * Blind spots (disclosed): a computed dynamic `import(variable)`, DI/registry
 * strings, and any package entry that isn't an index barrel escape the roots and
 * could make a live file look dead — so treat it as a lead, not a verdict.
 * Ranked by LOC (a large unreferenced file is the most worth removing).
 */
export function topDeadModules(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  ctx: ReportContext,
  limit: number,
): DeadModuleRow[] {
  const reached = reachableFromEntryRoots(nodes, edges);
  const rows: DeadModuleRow[] = [];
  for (const n of nodes) {
    if (n.kind !== "file" || reached.has(n.id) || isEntryRoot(n)) continue;
    if (!keepNode(ctx, n.id)) continue;
    rows.push({ nodeId: n.id, loc: lookupMetric(ctx, "loc", n.id) ?? 0, role: n.role ?? "source" });
  }
  rows.sort((a, b) => b.loc - a.loc || a.nodeId.localeCompare(b.nodeId));
  return rows.slice(0, limit);
}

/** Adjacency of forward module edges (`imports` / `re-exports`) by source file. */
function outgoingModuleEdges(
  edges: readonly GraphEdge[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== "imports" && e.kind !== "re-exports") continue;
    const bucket = out.get(e.srcId);
    if (bucket) bucket.push(e.dstId);
    else out.set(e.srcId, [e.dstId]);
  }
  return out;
}

/** Files reachable from the entry roots by a forward BFS over module edges. */
function reachableFromEntryRoots(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): Set<string> {
  const out = outgoingModuleEdges(edges);
  const reached = new Set<string>();
  const queue: string[] = [];
  for (const n of nodes) {
    if (isEntryRoot(n)) {
      reached.add(n.id);
      queue.push(n.id);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    for (const dst of out.get(queue[i]!) ?? []) {
      if (reached.has(dst)) continue;
      reached.add(dst);
      queue.push(dst);
    }
  }
  return reached;
}
