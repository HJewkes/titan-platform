import type { MetricDescriptor, SnapshotInfo } from "./schemas.js";

/** A graph node as the read API holds it; mirrors code-graph's `GraphNode` without importing it. */
export interface ModelNode {
  id: string;
  kind: string;
  name: string;
  parentId: string | null;
  language?: string;
  role?: string;
  attrs: Record<string, unknown>;
}

export interface ModelEdge {
  srcId: string;
  dstId: string;
  kind: string;
  attrs: Record<string, unknown>;
}

export interface ModelAlias {
  oldId: string;
  newId: string;
  reason: string;
}

export interface ModelMetric {
  nodeId: string;
  name: string;
  value: number | null;
  unit?: string;
}

/** A catalogue entry as code-graph's `describeMetric` returns it; provenance is added here. */
export interface CatalogueEntry {
  name: string;
  unit: string;
  appliesTo: readonly string[];
  rollup: MetricDescriptor["rollup"];
  direction: MetricDescriptor["direction"];
  absent: MetricDescriptor["absent"];
  source: string;
  description: string;
  window?: string;
}

/** Everything one snapshot holds, indexed for reads. Snapshots are immutable, so a model never goes stale. */
export interface ReadModel {
  snapshot: SnapshotInfo;
  nodes: readonly ModelNode[];
  nodeById: ReadonlyMap<string, ModelNode>;
  edges: readonly ModelEdge[];
  aliases: readonly ModelAlias[];
  /** Metric name to node id to value. */
  metrics: ReadonlyMap<string, ReadonlyMap<string, number | null>>;
  /** One descriptor per metric name present in the snapshot, sorted by name. */
  metricCatalogue: readonly MetricDescriptor[];
}

export interface ReadModelParts {
  snapshot: SnapshotInfo;
  nodes: readonly ModelNode[];
  edges: readonly ModelEdge[];
  aliases: readonly ModelAlias[];
  metrics: readonly ModelMetric[];
  /** The catalogue lookup, injected so this module never imports code-graph's Node-only root. */
  describe: (name: string) => CatalogueEntry | null;
}

export function buildReadModel(parts: ReadModelParts): ReadModel {
  const nodeById = new Map(parts.nodes.map((n) => [n.id, n]));
  return {
    snapshot: parts.snapshot,
    nodes: parts.nodes,
    nodeById,
    edges: parts.edges,
    aliases: parts.aliases,
    metrics: indexMetrics(parts.metrics),
    metricCatalogue: buildCatalogue(parts, nodeById),
  };
}

function indexMetrics(metrics: readonly ModelMetric[]): Map<string, Map<string, number | null>> {
  const byName = new Map<string, Map<string, number | null>>();
  for (const m of metrics) {
    let values = byName.get(m.name);
    if (!values) byName.set(m.name, (values = new Map()));
    values.set(m.nodeId, m.value);
  }
  return byName;
}

interface ObservedMetric {
  unit: string | null;
  kinds: Set<string>;
}

function observeMetrics(metrics: readonly ModelMetric[], nodeById: ReadonlyMap<string, ModelNode>): Map<string, ObservedMetric> {
  const observed = new Map<string, ObservedMetric>();
  for (const m of metrics) {
    let entry = observed.get(m.name);
    if (!entry) observed.set(m.name, (entry = { unit: m.unit ?? null, kinds: new Set() }));
    const kind = nodeById.get(m.nodeId)?.kind;
    if (kind) entry.kinds.add(kind);
  }
  return observed;
}

function buildCatalogue(parts: ReadModelParts, nodeById: ReadonlyMap<string, ModelNode>): MetricDescriptor[] {
  const observed = observeMetrics(parts.metrics, nodeById);
  const engine = `code-graph@${parts.snapshot.indexVersion}`;
  return [...observed.keys()].sort().map((name) => {
    const entry = parts.describe(name);
    return entry ? fromCatalogue(entry, engine) : uncatalogued(name, observed.get(name)!, engine);
  });
}

function fromCatalogue(entry: CatalogueEntry, engine: string): MetricDescriptor {
  const descriptor: MetricDescriptor = {
    name: entry.name,
    unit: entry.unit,
    appliesTo: [...entry.appliesTo],
    rollup: entry.rollup,
    direction: entry.direction,
    absent: entry.absent,
    description: entry.description,
    provenance: { kind: "measured", source: `${engine}/${entry.source}` },
  };
  if (entry.window !== undefined) descriptor.window = entry.window;
  return descriptor;
}

// A stored name the catalogue does not know: served with no judgement rather than dropped.
function uncatalogued(name: string, seen: ObservedMetric, engine: string): MetricDescriptor {
  return {
    name,
    unit: seen.unit,
    appliesTo: [...seen.kinds].sort(),
    rollup: "none",
    direction: "neutral",
    absent: "exclude",
    description: "Not in code-graph's metric catalogue.",
    provenance: { kind: "measured", source: `${engine}/uncatalogued` },
  };
}
