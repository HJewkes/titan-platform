import type { LiveSource, ReadModel, SnapshotInfo } from "@titan-design/code-read";
import { DATASET_FORMAT, type ExportedFile, type ReportDataset, type SnapshotData } from "../src/data/dataset.js";

/** Flattens snapshots from a live source into the JSON dataset a static page answers from. */
export function encodeDataset(source: LiveSource, snapshots: readonly SnapshotInfo[]): ReportDataset {
  const live = source.facts();
  return {
    format: DATASET_FORMAT,
    // Only flagged files travel with the export, so an arbitrary file's text is not available offline.
    facts: { ...live, dataset: "static", capabilities: { ...live.capabilities, excerpts: "flagged" } },
    snapshots: snapshots.map((info) => encodeSnapshot(source, info)),
  };
}

function encodeSnapshot(source: LiveSource, info: SnapshotInfo): SnapshotData {
  const model = source.model(info.id);
  return {
    snapshot: info,
    nodes: [...model.nodes],
    edges: [...model.edges],
    aliases: [...model.aliases],
    metrics: encodeMetrics(model),
    catalogue: [...model.metricCatalogue],
    findings: [...model.findings],
    rules: [...model.rules],
    files: flaggedFiles(source, model),
  };
}

function encodeMetrics(model: ReadModel): SnapshotData["metrics"] {
  const out: SnapshotData["metrics"] = {};
  for (const [name, values] of model.metrics) out[name] = [...values];
  return out;
}

/** The whole text of each file a finding sits in, so every context width `finding.get` allows is answerable. */
function flaggedFiles(source: LiveSource, model: ReadModel): Record<string, ExportedFile> {
  const files: Record<string, ExportedFile> = {};
  for (const finding of model.findings) {
    const path = fileOf(model, finding.nodeId);
    if (!path || files[path]) continue;
    const read = source.readSource?.(model.snapshot.id, path);
    if (!read || "unavailable" in read) continue;
    files[path] = { contentHash: read.contentHash, startLine: read.startLine, lines: [...read.lines], lineCount: read.lineCount };
  }
  return files;
}

function fileOf(model: ReadModel, nodeId: string): string | null {
  let node = model.nodeById.get(nodeId);
  while (node && node.kind !== "file") node = node.parentId ? model.nodeById.get(node.parentId) : undefined;
  return node?.id ?? null;
}
