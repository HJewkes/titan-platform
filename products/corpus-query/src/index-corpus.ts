import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { SpanFtsTables, runMigrations, spanFtsTablesDdl, type Db } from "@titan-design/store-sqlite";
import type { CorpusLayout } from "./layout.js";
import { splitParagraphs } from "./paragraphs.js";
import { ChapterMetaSchema, type ChapterMeta } from "./types.js";

export const SPAN_FIELD = "para";
export const chapterOwnerRef = (chapterId: string): string => `chap:${chapterId}`;

export function migrateIndex(db: Db): void {
  runMigrations(db, [
    {
      version: 1,
      name: "corpus-index",
      up(d) {
        d.exec(`
          CREATE TABLE chapter (
            source_id       INTEGER PRIMARY KEY,
            id              TEXT NOT NULL UNIQUE,
            rel_path        TEXT NOT NULL UNIQUE,
            sha256          TEXT NOT NULL,
            paragraph_count INTEGER NOT NULL,
            meta_json       TEXT NOT NULL
          );
        `);
      },
    },
  ]);
}

export function openSpans(db: Db): SpanFtsTables {
  db.exec(spanFtsTablesDdl());
  return new SpanFtsTables(db);
}

export interface IndexStats {
  /** Files the layout recognised as documents. */
  documents: number;
  indexed: number;
  unchanged: number;
  removed: number;
  /** Files the layout did not recognise. */
  skipped: number;
  /** Documents with no TITLE line, whose ref fell back to the id. */
  headerless: number;
  /** Paragraphs written by this run; unchanged files add none. */
  paragraphs: number;
}

interface ChapterRow {
  source_id: number;
  id: string;
  rel_path: string;
  sha256: string;
}

function listFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((p) => p.split(path.sep).join("/"))
    .filter((p) => statSync(path.join(root, p)).isFile())
    .sort();
}

/** Bring the index in line with the files under `root`: new and changed files are (re)indexed, vanished ones purged. */
export function indexCorpus(db: Db, root: string, layout: CorpusLayout): IndexStats {
  migrateIndex(db);
  const spans = openSpans(db);
  const stats: IndexStats = { documents: 0, indexed: 0, unchanged: 0, removed: 0, skipped: 0, headerless: 0, paragraphs: 0 };
  const known = new Map(db.prepare<[], ChapterRow>("SELECT source_id, id, rel_path, sha256 FROM chapter").all().map((r) => [r.rel_path, r]));
  const seen = new Set<string>();

  for (const relPath of listFiles(root)) {
    const bytes = readFileSync(path.join(root, relPath));
    const text = bytes.toString("utf8");
    const meta = layout.describe(relPath, text);
    if (!meta) {
      stats.skipped++;
      continue;
    }
    stats.documents++;
    seen.add(relPath);
    if (meta.title === "") stats.headerless++;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const prior = known.get(relPath);
    if (prior?.sha256 === sha256) {
      stats.unchanged++;
      continue;
    }
    stats.paragraphs += indexDocument(db, spans, meta, text, sha256, prior);
    stats.indexed++;
  }
  stats.removed = removeVanished(db, spans, known, seen);
  return stats;
}

function removeVanished(db: Db, spans: SpanFtsTables, known: Map<string, ChapterRow>, seen: Set<string>): number {
  let removed = 0;
  for (const [relPath, row] of known) {
    if (seen.has(relPath)) continue;
    spans.purgeOwner(chapterOwnerRef(row.id));
    db.prepare("DELETE FROM chapter WHERE source_id = ?").run(row.source_id);
    removed++;
  }
  return removed;
}

function indexDocument(db: Db, spans: SpanFtsTables, meta: ChapterMeta, text: string, sha256: string, prior: ChapterRow | undefined): number {
  const paragraphs = splitParagraphs(text);
  db.transaction((): void => {
    if (prior) spans.purgeOwner(chapterOwnerRef(prior.id));
    const sourceId = upsertChapter(db, meta, sha256, paragraphs.length, prior);
    for (const p of paragraphs) {
      spans.index({ ownerRef: chapterOwnerRef(meta.id), field: SPAN_FIELD, sourceId, byteOffset: p.byteOffset, byteLength: p.byteLength }, p.text);
    }
  })();
  return paragraphs.length;
}

function upsertChapter(db: Db, meta: ChapterMeta, sha256: string, count: number, prior: ChapterRow | undefined): number {
  const json = JSON.stringify(meta);
  if (prior) {
    db.prepare("UPDATE chapter SET id = ?, sha256 = ?, paragraph_count = ?, meta_json = ? WHERE source_id = ?").run(meta.id, sha256, count, json, prior.source_id);
    return prior.source_id;
  }
  const result = db.prepare("INSERT INTO chapter (id, rel_path, sha256, paragraph_count, meta_json) VALUES (?, ?, ?, ?, ?)").run(meta.id, meta.relPath, sha256, count, json);
  return Number(result.lastInsertRowid);
}

export function listChapters(db: Db): ChapterMeta[] {
  return db
    .prepare<[], { meta_json: string }>("SELECT meta_json FROM chapter")
    .all()
    .map((r) => ChapterMetaSchema.parse(JSON.parse(r.meta_json)));
}

/** Re-read one paragraph from its file by byte range. */
export function readSpanText(root: string, relPath: string, byteOffset: number, byteLength: number): string {
  const fd = openSync(path.join(root, relPath), "r");
  try {
    const buf = Buffer.alloc(byteLength);
    readSync(fd, buf, 0, byteLength, byteOffset);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
