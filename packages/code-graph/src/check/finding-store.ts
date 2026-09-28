import { createHash } from "node:crypto";
import type { CodeGraphStore } from "../store.js";
import type { Finding } from "./findings.js";

export type VerdictLabel = "confirmed" | "justified" | "unclear";

export interface VerdictCitation {
  path: string;
  lineStart: number;
  lineEnd: number;
  quote: string;
}

/** A finding as stored against a snapshot, addressed by its `findingKey`. */
export interface StoredFinding {
  key: string;
  finding: Finding;
  /** Hash of the excerpt a reader would be shown for this finding; carry-forward compares it. */
  excerptHash?: string;
}

/** A model's judgement of one stored finding, after its citations were verified. */
export interface StoredVerdict {
  key: string;
  verdict: VerdictLabel;
  rationale: string;
  citations: VerdictCitation[];
  /** Hash of the excerpt the verdict judged. */
  excerptHash: string;
  model?: string;
  costUsd?: number;
  runId?: string;
  provenance?: string;
  controlRun?: "ok" | "provisional";
  dropped?: string[];
  /** The snapshot this verdict was carried from, when carry-forward copied it. */
  carriedFrom?: number;
}

export interface FindingKeyInput {
  finding: Finding;
  /** The innermost symbol node id containing the finding; the finding's path when absent. */
  anchor?: string;
  /** The source text of the flagged lines. */
  flaggedText: string;
  excerptHash?: string;
}

/** Whitespace-insensitive, so reindenting or reflowing the flagged lines keeps the key. */
export function normalizeFlaggedText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0)
    .join("\n");
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * A finding's identity across snapshots: no line number, so an inserted line above it
 * keeps the key, and a collision ordinal separates same-rule findings on the same text.
 */
export function findingKey(input: FindingKeyInput, ordinal = 0): string {
  const { finding } = input;
  const anchor = input.anchor ?? finding.path;
  const textHash = hashText(normalizeFlaggedText(input.flaggedText));
  return `${finding.tool}:${finding.signal}:${anchor}:${textHash}#${ordinal}`;
}

/** Key a whole audit's findings, numbering collisions in source order so the result ignores input order. */
export function keyFindings(inputs: readonly FindingKeyInput[]): StoredFinding[] {
  const ordered = [...inputs].sort(compareBySource);
  const seen = new Map<string, number>();
  return ordered.map((input) => {
    const base = findingKey(input);
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    const stored: StoredFinding = { key: findingKey(input, ordinal), finding: input.finding };
    if (input.excerptHash !== undefined) stored.excerptHash = input.excerptHash;
    return stored;
  });
}

function compareBySource(a: FindingKeyInput, b: FindingKeyInput): number {
  const fa = a.finding;
  const fb = b.finding;
  return (
    fa.path.localeCompare(fb.path) ||
    (fa.lineStart ?? 0) - (fb.lineStart ?? 0) ||
    (fa.lineEnd ?? 0) - (fb.lineEnd ?? 0) ||
    (fa.evidence ?? "").localeCompare(fb.evidence ?? "") ||
    fa.id.localeCompare(fb.id)
  );
}

interface FindingDbRow {
  key: string;
  excerpt_hash: string | null;
  attrs: string;
}

interface VerdictDbRow {
  key: string;
  verdict: VerdictLabel;
  rationale: string;
  excerpt_hash: string;
  model: string | null;
  run_id: string | null;
  cost_usd: number | null;
  provenance: string | null;
  control_run: "ok" | "provisional" | null;
  carried_from: number | null;
  attrs: string;
}

/** Insert or replace findings by key within one snapshot. */
export function saveFindings(store: CodeGraphStore, snapshotId: number, findings: readonly StoredFinding[]): void {
  const insert = store.db.prepare(
    `INSERT OR REPLACE INTO finding
       (snapshot_id, key, finding_id, tool, signal, path, line_start, line_end, severity, excerpt_hash, attrs)
     VALUES (@snapshotId, @key, @findingId, @tool, @signal, @path, @lineStart, @lineEnd, @severity, @excerptHash, @attrs)`,
  );
  store.db.transaction(() => {
    for (const { key, finding, excerptHash } of findings) {
      insert.run({
        snapshotId,
        key,
        findingId: finding.id,
        tool: finding.tool,
        signal: finding.signal,
        path: finding.path,
        lineStart: finding.lineStart ?? null,
        lineEnd: finding.lineEnd ?? null,
        severity: finding.severity,
        excerptHash: excerptHash ?? null,
        attrs: JSON.stringify(finding),
      });
    }
  })();
}

export function listFindings(store: CodeGraphStore, snapshotId: number): StoredFinding[] {
  const rows = store.db
    .prepare("SELECT key, excerpt_hash, attrs FROM finding WHERE snapshot_id = ? ORDER BY key")
    .all(snapshotId) as FindingDbRow[];
  return rows.map((row) => {
    const stored: StoredFinding = { key: row.key, finding: JSON.parse(row.attrs) as Finding };
    if (row.excerpt_hash !== null) stored.excerptHash = row.excerpt_hash;
    return stored;
  });
}

/** Insert or replace verdicts by key within one snapshot. */
export function saveVerdicts(store: CodeGraphStore, snapshotId: number, verdicts: readonly StoredVerdict[]): void {
  const insert = store.db.prepare(
    `INSERT OR REPLACE INTO verdict
       (snapshot_id, key, verdict, rationale, excerpt_hash, model, run_id, cost_usd, provenance, control_run,
        carried_from, attrs)
     VALUES (@snapshotId, @key, @verdict, @rationale, @excerptHash, @model, @runId, @costUsd, @provenance,
        @controlRun, @carriedFrom, @attrs)`,
  );
  store.db.transaction(() => {
    for (const v of verdicts) insert.run(verdictParams(snapshotId, v));
  })();
}

function verdictParams(snapshotId: number, v: StoredVerdict): Record<string, unknown> {
  return {
    snapshotId,
    key: v.key,
    verdict: v.verdict,
    rationale: v.rationale,
    excerptHash: v.excerptHash,
    model: v.model ?? null,
    runId: v.runId ?? null,
    costUsd: v.costUsd ?? null,
    provenance: v.provenance ?? null,
    controlRun: v.controlRun ?? null,
    carriedFrom: v.carriedFrom ?? null,
    attrs: JSON.stringify({ citations: v.citations, dropped: v.dropped ?? [] }),
  };
}

export function listVerdicts(store: CodeGraphStore, snapshotId: number): StoredVerdict[] {
  const rows = store.db
    .prepare("SELECT * FROM verdict WHERE snapshot_id = ? ORDER BY key")
    .all(snapshotId) as VerdictDbRow[];
  return rows.map(rowToVerdict);
}

function rowToVerdict(row: VerdictDbRow): StoredVerdict {
  const attrs = JSON.parse(row.attrs) as { citations: VerdictCitation[]; dropped: string[] };
  const verdict: StoredVerdict = {
    key: row.key,
    verdict: row.verdict,
    rationale: row.rationale,
    citations: attrs.citations,
    excerptHash: row.excerpt_hash,
  };
  if (row.model !== null) verdict.model = row.model;
  if (row.cost_usd !== null) verdict.costUsd = row.cost_usd;
  if (row.run_id !== null) verdict.runId = row.run_id;
  if (row.provenance !== null) verdict.provenance = row.provenance;
  if (row.control_run !== null) verdict.controlRun = row.control_run;
  if (attrs.dropped.length > 0) verdict.dropped = attrs.dropped;
  if (row.carried_from !== null) verdict.carriedFrom = row.carried_from;
  return verdict;
}

/**
 * Copy each verdict of `from` onto the finding in `to` with the same key whose excerpt hash
 * equals the one the verdict judged. A verdict `to` already holds is kept. Returns the count copied.
 */
export function carryForwardVerdicts(store: CodeGraphStore, from: number, to: number): number {
  const targets = new Map(listFindings(store, to).map((f) => [f.key, f.excerptHash]));
  const existing = new Set(listVerdicts(store, to).map((v) => v.key));
  const carried = listVerdicts(store, from)
    .filter((v) => !existing.has(v.key) && targets.get(v.key) === v.excerptHash)
    .map((v) => ({ ...v, carriedFrom: v.carriedFrom ?? from }));
  saveVerdicts(store, to, carried);
  return carried.length;
}
