import type { Db } from "@titan-design/store-sqlite";
import { displayRef } from "./display-ref.js";
import { SPAN_FIELD, chapterOwnerRef, openSpans, readSpanText } from "./index-corpus.js";
import { buildMatch, type MatchTerms } from "./match.js";
import { compareStoryOrder } from "./story-order.js";
import { ChapterMetaSchema, type ChapterMeta, type Passage } from "./types.js";

export interface RetrieveOptions {
  /** Paragraphs of context on each side of a hit. */
  window?: number;
  /** Passages judged in earlier rounds; they are not returned again. */
  excludeIds?: ReadonlySet<string>;
}

export interface RetrieveResult {
  passages: Passage[];
  /** Paragraphs that matched, before windows were added. */
  hitParagraphs: number;
}

interface ChapterRow {
  source_id: number;
  sha256: string;
  paragraph_count: number;
  meta_json: string;
}

interface Chapter {
  row: ChapterRow;
  meta: ChapterMeta;
}

export const DEFAULT_WINDOW = 2;

export const passageId = (chapterId: string, first: number, last: number, fileSha8: string): string => `${chapterId}#p${first}-${last}@${fileSha8}`;

function chaptersByOwner(db: Db): Map<string, Chapter> {
  const rows = db.prepare<[], ChapterRow>("SELECT source_id, sha256, paragraph_count, meta_json FROM chapter").all();
  return new Map(
    rows.map((row) => {
      const meta = ChapterMetaSchema.parse(JSON.parse(row.meta_json));
      return [chapterOwnerRef(meta.id), { row, meta }];
    }),
  );
}

function spanCount(db: Db): number {
  return db.prepare<[], { n: number }>("SELECT count(*) AS n FROM search_span").get()!.n;
}

/** Byte offset to paragraph position for one chapter; spans are written in paragraph order. */
function paragraphIndex(db: Db, sourceId: number): Map<number, number> {
  const offsets = db.prepare<[number, string], { byte_offset: number }>("SELECT byte_offset FROM search_span WHERE source_id = ? AND field = ? ORDER BY byte_offset").all(sourceId, SPAN_FIELD);
  return new Map(offsets.map((o, i) => [o.byte_offset, i]));
}

function mergeWindows(hits: number[], window: number, last: number): [number, number][] {
  const merged: [number, number][] = [];
  for (const hit of [...hits].sort((a, b) => a - b)) {
    const range: [number, number] = [Math.max(0, hit - window), Math.min(last, hit + window)];
    const tail = merged[merged.length - 1];
    if (tail && range[0] <= tail[1]) tail[1] = Math.max(tail[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

/**
 * Every passage that holds a match, exhaustively and in story order. Unlike a ranked retriever this never
 * truncates, so the search limit is the span count.
 */
export function retrieve(db: Db, terms: MatchTerms, { window = DEFAULT_WINDOW, excludeIds = new Set() }: RetrieveOptions = {}): RetrieveResult {
  const hits = openSpans(db).search(buildMatch(terms), Math.max(1, spanCount(db)), { fields: [SPAN_FIELD] });
  const chapters = chaptersByOwner(db);
  const byChapter = new Map<string, number[]>();
  const positions = new Map<string, Map<number, number>>();
  for (const hit of hits) {
    const chapter = chapters.get(hit.ownerRef);
    if (chapter === undefined) continue;
    if (!positions.has(hit.ownerRef)) positions.set(hit.ownerRef, paragraphIndex(db, chapter.row.source_id));
    const position = positions.get(hit.ownerRef)!.get(hit.byteOffset);
    if (position === undefined) continue;
    byChapter.set(hit.ownerRef, [...(byChapter.get(hit.ownerRef) ?? []), position]);
  }
  const passages: Passage[] = [];
  for (const [owner, hitPositions] of byChapter) {
    const { row, meta } = chapters.get(owner)!;
    const fileSha8 = row.sha256.slice(0, 8);
    for (const [first, last] of mergeWindows(hitPositions, window, row.paragraph_count - 1)) {
      passages.push({ id: passageId(meta.id, first, last, fileSha8), chapterId: meta.id, ref: displayRef(meta), firstParagraph: first, lastParagraph: last, fileSha8 });
    }
  }
  const order = new Map([...chapters.values()].map((c) => [c.meta.id, c.meta.order]));
  passages.sort((a, b) => compareStoryOrder(order.get(a.chapterId)!, order.get(b.chapterId)!) || a.firstParagraph - b.firstParagraph);
  return { passages: passages.filter((p) => !excludeIds.has(p.id)), hitParagraphs: hits.length };
}

/** Re-read a passage's paragraphs from the corpus files by byte range. */
export function readPassage(db: Db, root: string, passage: Passage): string[] {
  const row = db.prepare<[string], { source_id: number; rel_path: string }>("SELECT source_id, rel_path FROM chapter WHERE id = ?").get(passage.chapterId);
  if (!row) throw new Error(`passage ${passage.id} is not in the index`);
  return db
    .prepare<[number, string], { byte_offset: number; byte_length: number }>("SELECT byte_offset, byte_length FROM search_span WHERE source_id = ? AND field = ? ORDER BY byte_offset")
    .all(row.source_id, SPAN_FIELD)
    .slice(passage.firstParagraph, passage.lastParagraph + 1)
    .map((s) => readSpanText(root, row.rel_path, s.byte_offset, s.byte_length));
}
