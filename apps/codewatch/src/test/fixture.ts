import type { MetricDescriptor, ModelFinding, ModelNode, SnapshotInfo } from "@titan-design/code-read/query";
import { SNAPSHOT_FORMAT, type Snapshot } from "@titan-design/rpc-client";
import { DATASET_FORMAT, type ReportDataset, type SnapshotData } from "../data/dataset.js";

const INFO: SnapshotInfo = { id: 7, ref: "main", commit: "abcdef1234567890", takenAt: "2026-09-19T10:00:00Z", indexVersion: "0.15.0" };

const file = (id: string): ModelNode => ({ id, kind: "file", name: id.split("/").pop()!, parentId: null, role: "source", attrs: {} });

const descriptor = (name: string, direction: MetricDescriptor["direction"], rollup: MetricDescriptor["rollup"]): MetricDescriptor => ({
  name, unit: "count", appliesTo: ["file"], rollup, direction, absent: "exclude",
  description: `${name} for tests`, provenance: { kind: "measured", source: "code-graph@0.15.0/source" },
});

const FINDINGS: ModelFinding[] = [
  { id: "max-loc|src/big.ts", rule: "max-loc", severity: "error", nodeId: "src/big.ts", metric: "loc", value: 400, threshold: 300, message: "loc=400 > 300" },
  {
    id: "no-fs|src/io.ts|node:fs", rule: "no-fs", severity: "warning", nodeId: "src/io.ts", destinationId: "node:fs",
    message: "src/io.ts imports node:fs", ranges: [{ startLine: 2, endLine: 2 }],
  },
  { id: "max-loc|lib/far.ts", rule: "max-loc", severity: "warning", nodeId: "lib/far.ts", metric: "loc", value: 320, threshold: 300, message: "loc=320 > 300" },
];

function snapshotData(): SnapshotData {
  return {
    snapshot: INFO,
    nodes: [file("src/big.ts"), file("src/io.ts"), file("lib/far.ts"), { id: "node:fs", kind: "external", name: "node:fs", parentId: null, attrs: {} }],
    edges: [
      { srcId: "src/io.ts", dstId: "src/big.ts", kind: "imports", attrs: { weight: 3 } },
      { srcId: "src/io.ts", dstId: "node:fs", kind: "imports", attrs: { weight: 1 } },
    ],
    aliases: [],
    metrics: {
      loc: [["src/big.ts", 400], ["src/io.ts", 40], ["lib/far.ts", 320]],
      fan_out: [["src/big.ts", 0], ["src/io.ts", 2], ["lib/far.ts", 0]],
    },
    catalogue: [descriptor("fan_out", "higher-worse", "none"), descriptor("loc", "higher-worse", "sum")],
    findings: FINDINGS,
    rules: [
      { id: "max-loc", type: "metric-max", severity: "error", text: "Files must stay at or under 300 lines." },
      { id: "no-fs", type: "forbid-import", severity: "warning", text: "Files matching src/** must not import node:fs." },
    ],
    files: { "src/io.ts": { contentHash: "h-io", startLine: 1, lines: ["// io", 'import { readFile } from "node:fs";', "export const x = 1;"], lineCount: 3 } },
  };
}

/** Three files in two directories, three findings; only src/io.ts carries its text. */
export function fixtureDataset(overrides: Partial<ReportDataset> = {}): ReportDataset {
  return {
    format: DATASET_FORMAT,
    facts: {
      dataset: "static",
      commands: ["api.describe", "finding.get", "findings.list", "hierarchy.get", "node.get", "node.neighbors", "node.resolve", "snapshot.list"],
      capabilities: { findings: "check-rules", verdicts: false, themes: false, feedback: false, embeddings: null, cochange: false, sourceAtCommit: false, excerpts: "flagged" },
      rules: [{ id: "max-loc", type: "metric-max", severity: "error" }, { id: "no-fs", type: "forbid-import", severity: "warning" }],
    },
    snapshots: [snapshotData()],
    ...overrides,
  };
}

export const FIXTURE_SNAPSHOT_ID = INFO.id;

/** `null` builds a snapshot with no dataset, so only recorded calls answer. */
export function fixtureSnapshot(dataset: ReportDataset | null = fixtureDataset()): Snapshot {
  return { format: SNAPSHOT_FORMAT, createdAt: "2026-09-19T10:05:00Z", calls: {}, ...(dataset === null ? {} : { dataset }) };
}
