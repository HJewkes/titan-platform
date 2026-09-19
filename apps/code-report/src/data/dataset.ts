import {
  buildReadModel,
  snapshotNotFound,
  type CatalogueEntry,
  type MetricDescriptor,
  type ModelAlias,
  type ModelEdge,
  type ModelFinding,
  type ModelMetric,
  type ModelNode,
  type ModelRule,
  type ReadModel,
  type ReadSource,
  type SnapshotInfo,
  type SourceFacts,
  type SourceRead,
} from "@titan-design/code-read/query";

/**
 * A static export's dataset: every snapshot's read model, flattened to JSON, so the browser answers
 * any call through code-read's own query functions. Product-side until code-read ships one (see README).
 */
export const DATASET_FORMAT = "code-report-dataset@1";

/** The lines of one flagged file as they were at the snapshot. */
export interface ExportedFile {
  contentHash: string;
  startLine: number;
  lines: string[];
  lineCount: number;
}

export interface SnapshotData {
  snapshot: SnapshotInfo;
  nodes: ModelNode[];
  edges: ModelEdge[];
  aliases: ModelAlias[];
  /** Metric name to `[nodeId, value]` pairs, about half the bytes of one object per row. */
  metrics: Record<string, Array<[string, number | null]>>;
  catalogue: MetricDescriptor[];
  findings: ModelFinding[];
  rules: ModelRule[];
  /** Path to text, for the files findings point at. */
  files: Record<string, ExportedFile>;
}

export interface ReportDataset {
  format: typeof DATASET_FORMAT;
  facts: SourceFacts;
  /** Newest first, as `ReadSource.snapshots` requires. */
  snapshots: SnapshotData[];
}

export function isReportDataset(value: unknown): value is ReportDataset {
  return typeof value === "object" && value !== null && (value as { format?: unknown }).format === DATASET_FORMAT;
}

/** A `ReadSource` over a decoded dataset; models are built on first use, since each costs a pass over the snapshot. */
export function datasetSource(dataset: ReportDataset): ReadSource {
  const byId = new Map(dataset.snapshots.map((s) => [s.snapshot.id, s]));
  const models = new Map<number, ReadModel>();
  const dataFor = (snapshotId: number): SnapshotData => {
    const data = byId.get(snapshotId);
    if (!data) throw snapshotNotFound(snapshotId);
    return data;
  };
  return {
    facts: () => dataset.facts,
    snapshots: () => dataset.snapshots.map((s) => s.snapshot),
    model: (snapshotId) => {
      const cached = models.get(snapshotId);
      if (cached) return cached;
      const model = toModel(dataFor(snapshotId));
      models.set(snapshotId, model);
      return model;
    },
    readSource: (snapshotId, path) => readExported(dataFor(snapshotId), path),
  };
}

function toModel(data: SnapshotData): ReadModel {
  return buildReadModel({
    snapshot: data.snapshot,
    nodes: data.nodes,
    edges: data.edges,
    aliases: data.aliases,
    metrics: flattenMetrics(data.metrics, data.catalogue),
    describe: catalogueLookup(data.catalogue),
    findings: data.findings,
    rules: data.rules,
  });
}

function flattenMetrics(metrics: SnapshotData["metrics"], catalogue: readonly MetricDescriptor[]): ModelMetric[] {
  const units = new Map(catalogue.map((d) => [d.name, d.unit]));
  const rows: ModelMetric[] = [];
  for (const [name, pairs] of Object.entries(metrics)) {
    const unit = units.get(name) ?? undefined;
    for (const [nodeId, value] of pairs) rows.push(unit === undefined ? { nodeId, name, value } : { nodeId, name, value, unit });
  }
  return rows;
}

/** Rebuilds code-graph's catalogue from the exported descriptors, so the browser never imports code-graph. */
function catalogueLookup(catalogue: readonly MetricDescriptor[]): (name: string) => CatalogueEntry | null {
  const entries = new Map<string, CatalogueEntry>();
  for (const d of catalogue) {
    // provenance.source is "code-graph@<version>/<source>"; "uncatalogued" is rebuilt by buildReadModel itself.
    const source = d.provenance.source.slice(d.provenance.source.indexOf("/") + 1);
    if (source === "uncatalogued") continue;
    const entry: CatalogueEntry = {
      name: d.name, unit: d.unit ?? "", appliesTo: d.appliesTo, rollup: d.rollup,
      direction: d.direction, absent: d.absent, source, description: d.description,
    };
    if (d.window !== undefined) entry.window = d.window;
    entries.set(d.name, entry);
  }
  return (name) => entries.get(name) ?? null;
}

function readExported(data: SnapshotData, path: string): SourceRead {
  const file = data.files[path];
  if (!file) return { unavailable: "not-in-export" };
  return { path, contentHash: file.contentHash, origin: "export", startLine: file.startLine, lines: file.lines, lineCount: file.lineCount };
}
