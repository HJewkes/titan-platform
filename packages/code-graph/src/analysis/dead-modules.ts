import type { GraphEdge, GraphNode, NodeRole } from "../types.js";
import { UNIMPORTED_ROLES } from "../unimported-roles.js";
import { keepNode, lookupMetric, type ReportContext } from "./graph-report-sections.js";
import type {
  DeadModuleConsumer,
  DeadModuleRow,
  DeadModulesOptions,
  DeadModuleView,
} from "./graph-report-types.js";

/**
 * Roles that seed reachability (and are never themselves "dead"): every role
 * nothing imports by design, plus package barrels (re-export hubs). Everything a
 * repo actually runs is reachable from these — with dynamic `import()` edges now
 * captured (C-65), the CLI's lazily-loaded command surface is reachable too, so
 * live commands aren't falsely flagged.
 */
const ENTRY_ROOT_ROLES: ReadonlySet<NodeRole> = new Set<NodeRole>([...UNIMPORTED_ROLES, "barrel"]);

/** The product's own seeds: what ships or runs, not what only exercises or showcases it. */
const PUBLIC_ROOT_ROLES: ReadonlySet<NodeRole> = new Set<NodeRole>(["entry", "barrel", "config", "script"]);

/** Unreachable by design, so never a row in either view. */
const NEVER_ROW_ROLES: ReadonlySet<NodeRole> = new Set<NodeRole>(["test", "fixture", "story", "lab"]);

/** Most specific first: the first consumer that reaches a file names it. */
const CONSUMER_PRECEDENCE: readonly DeadModuleConsumer[] = ["lab", "story", "test"];

/**
 * A file that is conventionally a bundler entry point even though nothing imports
 * it — a `main.{ts,tsx,js,jsx}` (Vite/CRA/webpack default, referenced from
 * `index.html`, not from code). Seeds reachability so a whole SPA under it isn't
 * flagged unreferenced. (`index.*` is already the `barrel` role.)
 */
const ENTRY_FILE_RE = /(?:^|\/)main\.[jt]sx?$/;

function isRoot(node: GraphNode, roles: ReadonlySet<NodeRole>): boolean {
  return (
    node.kind === "file" &&
    ((node.role !== undefined && roles.has(node.role)) || ENTRY_FILE_RE.test(node.id))
  );
}

function isRowCandidate(node: GraphNode, roots: ReadonlySet<NodeRole>): boolean {
  if (node.kind !== "file" || isRoot(node, roots)) return false;
  return node.role === undefined || !NEVER_ROW_ROLES.has(node.role);
}

/**
 * Files unreachable from the entry roots by a forward BFS over `imports` /
 * `re-exports` edges — "no importer found given configured entry points" (C-65),
 * NOT proven dead. Catches transitively-dead chains, not just fan-in-0 files.
 * Blind spots (disclosed): a computed dynamic `import(variable)`, DI/registry
 * strings, and any package entry that isn't an index barrel escape the roots and
 * could make a live file look dead — so treat it as a lead, not a verdict.
 * Ranked by LOC (a large unreferenced file is the most worth removing).
 *
 * The `"public"` view (C-155) drops test, story and lab from the seeds and tags a
 * row those still reach with `reachableOnlyFrom`.
 */
export function topDeadModules(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  ctx: ReportContext,
  limit: number,
  options: DeadModulesOptions = {},
): DeadModuleRow[] {
  const view: DeadModuleView = options.view ?? "all-consumers";
  const roots = view === "public" ? PUBLIC_ROOT_ROLES : ENTRY_ROOT_ROLES;
  const out = outgoingModuleEdges(edges);
  const reached = reachableFrom(nodes, out, (n) => isRoot(n, roots));
  const consumerOf = view === "public" ? consumerLookup(nodes, out) : () => undefined;
  const rows: DeadModuleRow[] = [];
  for (const n of nodes) {
    if (!isRowCandidate(n, roots) || reached.has(n.id) || !keepNode(ctx, n.id)) continue;
    const row: DeadModuleRow = { nodeId: n.id, loc: lookupMetric(ctx, "loc", n.id) ?? 0, role: n.role ?? "source" };
    const consumer = consumerOf(n.id);
    if (consumer) row.reachableOnlyFrom = consumer;
    rows.push(row);
  }
  rows.sort((a, b) => b.loc - a.loc || a.nodeId.localeCompare(b.nodeId));
  return rows.slice(0, limit);
}

/** Names the highest-precedence consumer role whose files reach a given file. */
function consumerLookup(
  nodes: readonly GraphNode[],
  out: ReadonlyMap<string, string[]>,
): (id: string) => DeadModuleConsumer | undefined {
  const reachedBy = CONSUMER_PRECEDENCE.map(
    (role) => [role, reachableFrom(nodes, out, (n) => n.kind === "file" && n.role === role)] as const,
  );
  return (id) => reachedBy.find(([, reached]) => reached.has(id))?.[0];
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

/** Files reachable from the seed nodes by a forward BFS over module edges. */
function reachableFrom(
  nodes: readonly GraphNode[],
  out: ReadonlyMap<string, string[]>,
  isSeed: (node: GraphNode) => boolean,
): Set<string> {
  const reached = new Set<string>();
  const queue: string[] = [];
  for (const n of nodes) {
    if (isSeed(n)) {
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
