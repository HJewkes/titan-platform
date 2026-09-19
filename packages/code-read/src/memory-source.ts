import { describeMetric } from "@titan-design/code-graph";
import { COMMAND_NAMES } from "./query/contract.js";
import {
  buildReadModel,
  type CatalogueEntry,
  type ModelEdge,
  type ModelFinding,
  type ModelMetric,
  type ModelNode,
  type ModelRule,
  type ReadModel,
} from "./query/model.js";
import type { QueryResolver } from "./query/resolver.js";
import type { SnapshotInfo } from "./query/schemas.js";
import { snapshotNotFound, type ReadSource, type SourceRead } from "./query/source.js";

/** A snapshot for in-memory tests: nodes, metrics, and an optional catalogue override. */
export interface MemorySnapshot {
  info: SnapshotInfo;
  nodes: ModelNode[];
  metrics: ModelMetric[];
  describe?: (name: string) => CatalogueEntry | null;
  edges?: ModelEdge[];
  findings?: ModelFinding[];
  rules?: ModelRule[];
  /** Path to the file's lines as a static export would hold them; `startLine` above 1 makes a partial window. */
  sources?: Record<string, { lines: string[]; startLine?: number; lineCount?: number }>;
}

export const snapshotInfo = (id: number, ref = "main", indexVersion = "0.14.0"): SnapshotInfo => ({
  id, ref, commit: null, takenAt: `2026-09-${String(id).padStart(2, "0")}T00:00:00Z`, indexVersion,
});

export const file = (id: string, role = "source"): ModelNode => ({ id, kind: "file", name: id.split("/").pop()!, parentId: null, role, attrs: {} });

export function symbol(fileId: string, name: string, startLine?: number, endLine?: number): ModelNode {
  const attrs = startLine === undefined ? {} : { startLine, endLine };
  return { id: `${fileId}#${name}`, kind: "symbol", name, parentId: fileId, attrs };
}

export const metric = (nodeId: string, name: string, value: number | null): ModelMetric => ({ nodeId, name, value });

export const edge = (srcId: string, dstId: string, kind = "imports", weight?: number): ModelEdge => ({
  srcId, dstId, kind, attrs: weight === undefined ? {} : { weight },
});

function readFrom(snapshots: readonly MemorySnapshot[]): ReadSource["readSource"] {
  return (snapshotId, path): SourceRead => {
    const file = snapshots.find((s) => s.info.id === snapshotId)?.sources?.[path];
    if (!file) return { unavailable: "not-in-export" };
    const startLine = file.startLine ?? 1;
    const lineCount = file.lineCount ?? file.lines.length;
    return { path, contentHash: `hash:${path}`, origin: "export", startLine, lines: file.lines, lineCount };
  };
}

/** A static-style source over hand-built snapshots, newest first, using code-graph's real catalogue by default. */
export function memorySource(snapshots: MemorySnapshot[]): ReadSource {
  const models = new Map<number, ReadModel>();
  for (const s of snapshots) {
    const model = buildReadModel({
      snapshot: s.info, nodes: s.nodes, edges: s.edges ?? [], aliases: [], metrics: s.metrics,
      describe: s.describe ?? describeMetric, findings: s.findings ?? [], rules: s.rules ?? [],
    });
    models.set(s.info.id, model);
  }
  const hasSources = snapshots.some((s) => s.sources !== undefined);
  return {
    ...(hasSources ? { readSource: readFrom(snapshots) } : {}),
    facts: () => ({
      dataset: "static",
      commands: COMMAND_NAMES,
      capabilities: { findings: "none", verdicts: false, themes: false, feedback: false, embeddings: null, cochange: false, sourceAtCommit: false, excerpts: "none" },
      rules: [],
    }),
    snapshots: () => snapshots.map((s) => s.info),
    model: (id) => {
      const model = models.get(id);
      if (!model) throw snapshotNotFound(id);
      return model;
    },
  };
}

/** A resolver that throws on an error envelope, for tests that only read successes. */
export function answer(resolve: QueryResolver): <T>(name: string, args: unknown) => T {
  return <T>(name: string, args: unknown): T => {
    const envelope = resolve(name, args);
    if (!envelope.ok) throw Object.assign(new Error(envelope.error), { code: envelope.code });
    return envelope.data as T;
  };
}
