import { promises as fs } from "node:fs";
import { contentHash, resumePoint } from "@titan-design/locator";
import { TranscriptParseError, extractTranscript, type DiscoveredTranscript } from "@titan-design/session-read";
import { applyDelta } from "./apply.js";
import { allSessionIds, type SessionGraph } from "./graph.js";
import { reconcile, rollupSessions, type ReconcileCounts } from "./rollup.js";
import { allTaskIds, enrichTasks, NO_ENRICHMENT, type TaskEnrichment, type TaskResolver } from "./tasks.js";

export interface IndexOptions {
  /** Re-hash the already-read prefix to catch same-length rewrites. O(file), so opt in. */
  verifyHash?: boolean;
  /** Store a whole-file content hash for durability reporting. O(file), so opt in. */
  withContentHash?: boolean;
  /** Fill task title, initiative and present status from the caller's store. Absent means transcripts alone. */
  resolveTasks?: TaskResolver;
}

export type TranscriptOutcome =
  | { status: "unchanged" | "indexed" | "rewound"; transcriptId: number; sessionIds: string[]; facts: number; tasks: TaskEnrichment }
  | { status: "missing" | "quarantined"; transcriptId: number; sessionIds: string[]; facts: 0; tasks: TaskEnrichment; reason: string };

/**
 * Bring one transcript up to date: read from its watermark (or byte 0 after a
 * rewrite), apply the delta, advance the watermark. A malformed line
 * quarantines the transcript instead of poisoning the pass.
 */
export async function indexTranscript(graph: SessionGraph, transcript: DiscoveredTranscript, options: IndexOptions = {}): Promise<TranscriptOutcome> {
  const row = graph.transcripts.ensure(transcript.displayPath);
  const entry = { path: transcript.displayPath, lastByteOffset: row.lastOffset, prefixHash: row.prefixHash };
  const point = await resumePoint(entry, transcript.absolutePath, { verifyHash: options.verifyHash });
  const base = { transcriptId: row.sourceId, sessionIds: [] as string[], tasks: NO_ENRICHMENT };
  if (point.state === "missing") {
    graph.transcripts.markStatus(transcript.displayPath, "missing", "source file no longer exists");
    return { ...base, status: "missing", facts: 0, reason: "source file no longer exists" };
  }
  if (point.state === "unchanged") return { ...base, status: "unchanged", facts: 0 };

  try {
    const delta = await extractTranscript(transcript.absolutePath, {
      fromByteOffset: point.start,
      priorPrefixHash: point.state === "rewritten" ? null : row.prefixHash,
      subagentId: transcript.subagentId,
    });
    applyDelta(graph, row.sourceId, delta);
    const stat = await fs.stat(transcript.absolutePath);
    graph.transcripts.advance(transcript.displayPath, {
      lastOffset: delta.lastByteOffset,
      prefixHash: delta.prefixHash,
      fileSize: stat.size,
      fileMtime: stat.mtime.toISOString(),
      contentHash: options.withContentHash ? await contentHash(transcript.absolutePath) : null,
    });
    const sessionIds = delta.sessions.map((s) => s.sessionId);
    const taskIds = delta.tasks.map((t) => t.taskId);
    const tasks = taskIds.length > 0 ? await enrichTasks(graph, options.resolveTasks, taskIds) : NO_ENRICHMENT;
    return { ...base, sessionIds, tasks, status: point.state === "rewritten" ? "rewound" : "indexed", facts: delta.facts.length };
  } catch (err) {
    if (!(err instanceof TranscriptParseError)) throw err;
    graph.transcripts.markStatus(transcript.displayPath, "quarantined", err.message);
    return { ...base, status: "quarantined", facts: 0, reason: err.message };
  }
}

export interface RefreshSummary {
  transcripts: number;
  indexed: number;
  unchanged: number;
  rewound: number;
  missing: number;
  quarantined: number;
  facts: number;
  turnsRolledUp: number;
  reconciled: ReconcileCounts;
  tasks: TaskEnrichment;
  markedMissing: number;
}

/**
 * One pass over a corpus: index every transcript, roll up the sessions that
 * changed, reconcile cross-transcript observations, enrich tasks, and mark rows
 * whose source file is gone. Idempotent: a second pass over unchanged files
 * changes nothing.
 *
 * The resolver is hoisted out of the per-transcript loop and run once over the
 * whole task table, so a corpus of N transcripts costs one resolver call rather
 * than N, and a task whose store row changed refreshes even when no transcript
 * did. That bounds staleness to one pass.
 */
export async function refreshCorpus(graph: SessionGraph, transcripts: readonly DiscoveredTranscript[], options: IndexOptions & { full?: boolean } = {}): Promise<RefreshSummary> {
  const { resolveTasks, ...perTranscript } = options;
  const counts = { indexed: 0, unchanged: 0, rewound: 0, missing: 0, quarantined: 0 };
  const touched: string[] = [];
  let facts = 0;
  for (const transcript of transcripts) {
    const outcome = await indexTranscript(graph, transcript, perTranscript);
    counts[outcome.status] += 1;
    facts += outcome.facts;
    touched.push(...outcome.sessionIds);
  }
  const turnsRolledUp = rollupSessions(graph, options.full ? allSessionIds(graph) : touched);
  const reconciled = reconcile(graph);
  const tasks = await enrichTasks(graph, resolveTasks, allTaskIds(graph));
  const markedMissing = await markMissing(graph, transcripts);
  return { transcripts: transcripts.length, ...counts, facts, turnsRolledUp, reconciled, tasks, markedMissing };
}

/** Rows absent from discovery are only nominated; an `fs.stat` decides, so an empty scan cannot condemn the corpus. */
async function markMissing(graph: SessionGraph, discovered: readonly DiscoveredTranscript[]): Promise<number> {
  const present = new Set(discovered.map((t) => t.displayPath));
  const byPath = new Map(discovered.map((t) => [t.displayPath, t.absolutePath]));
  let marked = 0;
  for (const row of graph.transcripts.list()) {
    if (row.status === "missing" || present.has(row.sourceKey)) continue;
    const absolute = byPath.get(row.sourceKey) ?? row.sourceKey;
    if (await exists(absolute)) continue;
    graph.transcripts.markStatus(row.sourceKey, "missing", "source file no longer exists");
    marked += 1;
  }
  return marked;
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await fs.stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}
