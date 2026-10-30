import { WatermarkTable, type Db } from "@titan-design/store-sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseTimingArtifact } from "./artifact.js";
import { archiveRaw } from "./archive.js";
import { isLegacyArtifact, upgradeLegacyArtifact, type GhRunMeta, type LegacyUpgrade } from "./legacy.js";
import { ingestArtifact, type IngestResult } from "./store.js";

const hasRun = (db: Db, id: string) => db.prepare("SELECT 1 FROM runs WHERE id = ?").get(id) !== undefined;

/**
 * Archives then stores one record. A run the store already holds is skipped before anything is written, so a
 * repeated ingest neither duplicates rows nor appends a second checksum line.
 */
export function ingestRecord(db: Db, home: string, input: unknown): IngestResult {
  const { run } = parseTimingArtifact(input);
  if (hasRun(db, run.id)) return { runId: run.id, inserted: false, files: 0 };
  return ingestArtifact(db, input, archiveRaw(home, run, `${JSON.stringify(input)}\n`));
}

export interface ArtifactName {
  attempt: number;
  shard: string | null;
}

/** `vitest-file-timing-<attempt>` from a pull request's validate job, `...-shard<i>of<n>-<attempt>` from main's shards. */
export function parseArtifactName(name: string): ArtifactName | null {
  const match = /^vitest-file-timing-(?:shard(\d+)of(\d+)-)?(\d+)$/.exec(name);
  if (!match) return null;
  const [, index, count, attempt] = match;
  return { attempt: Number(attempt), shard: index ? `${index}/${count}` : null };
}

/**
 * One downloaded CI artifact. A pre-header record gets its header from the run's metadata; the attempt comes from the
 * artifact's name, because a run's artifacts include those of its earlier attempts.
 */
export function ingestGhArtifact(db: Db, home: string, name: string, input: unknown, meta: GhRunMeta, legacyScope?: LegacyUpgrade["scope"]): IngestResult {
  const parsed = parseArtifactName(name);
  if (!parsed) throw new Error(`not a vitest-file-timing artifact: ${name}`);
  if (!isLegacyArtifact(input)) return ingestRecord(db, home, input);
  // A backfill that knows the old run's scope says so; otherwise only a main push is known to run the full suite.
  const scope = legacyScope ?? (meta.event === "push" ? "full" : "scoped");
  return ingestRecord(db, home, upgradeLegacyArtifact(input, { ...meta, attempt: parsed.attempt }, { shard: parsed.shard, scope }));
}

const fetchKey = (databaseId: number, attempt: number) => `gha-fetch:${databaseId}:${attempt}`;

/** True once a run attempt's artifacts were all downloaded and ingested, so a scheduled ingest skips it. */
export function ghRunFetched(db: Db, databaseId: number, attempt: number): boolean {
  return new WatermarkTable(db).get(fetchKey(databaseId, attempt))?.lastIndexedAt != null;
}

/** Marks a run attempt done, with how many artifacts it had; zero is a real answer (a none-scope run uploads none). */
export function markGhRunFetched(db: Db, databaseId: number, attempt: number, artifacts: number): void {
  const marks = new WatermarkTable(db);
  marks.ensure(fetchKey(databaseId, attempt));
  marks.advance(fetchKey(databaseId, attempt), { lastOffset: artifacts });
}

export interface SpoolOptions {
  spool?: string;
  now?: number;
  /** A record younger than this may still be being written by the reporter, so it waits for the next pass. */
  minAgeMs?: number;
}

export interface SpoolResult {
  ingested: number;
  duplicates: number;
  waiting: number;
  rejected: { file: string; reason: string }[];
}

function reject(spool: string, file: string, reason: string): void {
  const dir = join(spool, "rejected");
  mkdirSync(dir, { recursive: true });
  renameSync(join(spool, file), join(dir, file));
  writeFileSync(join(dir, `${file}.reason`), `${reason}\n`);
}

function reasonOf(error: unknown): string {
  if (error instanceof z.ZodError) return z.prettifyError(error).replace(/\s*\n\s*/g, " ");
  return error instanceof Error ? error.message : String(error);
}

type SpoolOutcome = { kind: "ingested" | "duplicates" | "waiting" } | { kind: "rejected"; reason: string };

function ingestSpoolFile(db: Db, home: string, spool: string, name: string, settledBefore: number): SpoolOutcome {
  const path = join(spool, name);
  if (statSync(path).mtimeMs > settledBefore) return { kind: "waiting" };
  try {
    const outcome = ingestRecord(db, home, JSON.parse(readFileSync(path, "utf8")));
    unlinkSync(path);
    return { kind: outcome.inserted ? "ingested" : "duplicates" };
  } catch (error) {
    const reason = reasonOf(error);
    reject(spool, name, reason);
    return { kind: "rejected", reason };
  }
}

/**
 * Moves every settled spool record into the raw archive and the store. The spool copy is deleted once it is archived;
 * an unreadable one goes to `rejected/` beside a `.reason` file, so a bad record is kept but never retried.
 */
export function ingestSpool(db: Db, home: string, options: SpoolOptions = {}): SpoolResult {
  const { spool = join(home, "spool"), now = Date.now(), minAgeMs = 60_000 } = options;
  const result: SpoolResult = { ingested: 0, duplicates: 0, waiting: 0, rejected: [] };
  if (!existsSync(spool)) return result;
  const files = readdirSync(spool, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  for (const { name } of files) {
    const outcome = ingestSpoolFile(db, home, spool, name, now - minAgeMs);
    if (outcome.kind === "rejected") result.rejected.push({ file: name, reason: outcome.reason });
    else result[outcome.kind] += 1;
  }
  return result;
}
