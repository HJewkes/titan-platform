import { readFileSync } from "node:fs";
import path from "node:path";
import { openDatabase, type Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chapterOwnerRef, indexCorpus, openSpans, readSpanText, SPAN_FIELD } from "./index-corpus.js";
import { archiveLayout } from "./layout.js";
import { writeCorpus, writeFile, type SyntheticFile } from "./synthetic-corpus.test-helpers.js";

const MULTIBYTE = "Café “Zürich” 🏆 naïve résumé — 東京タワー";

const FILES: SyntheticFile[] = [
  { relPath: "northwind/book_01/chapter_01.txt", title: "NW 1.1 - Start", published: "2026-01-01", body: `${MULTIBYTE} opens the harbour.\n\nSecond paragraph about lanterns.\n\n\n  Third, indented, ${MULTIBYTE}.\n` },
  { relPath: "northwind/book_01/chapter_02.txt", title: "NW 1.2 - Next", published: "2026-01-02", body: "Only paragraph, about kettles.\n" },
  { relPath: "other/2026-02-01_Notice.txt", title: "Notice", published: "2026-02-01", body: "A notice about teapots.\n" },
  { relPath: "stray/readme.md", body: "ignored" },
];

let db: Db;
let cleanup: () => void;
let root: string;

beforeEach(() => {
  ({ root, cleanup } = writeCorpus(FILES));
  db = openDatabase(":memory:");
});
afterEach(() => {
  db.close();
  cleanup();
});

interface SpanRow {
  byteOffset: number;
  byteLength: number;
  relPath: string;
}

function paragraphsOf(chapterId: string): SpanRow[] {
  return db.prepare<[string, string], SpanRow>("SELECT s.byte_offset AS byteOffset, s.byte_length AS byteLength, c.rel_path AS relPath FROM search_span s JOIN chapter c ON c.source_id = s.source_id WHERE s.owner_ref = ? AND s.field = ? ORDER BY s.byte_offset").all(chapterOwnerRef(chapterId), SPAN_FIELD);
}

describe("indexCorpus", () => {
  it("counts documents, skips files the layout does not know and reports headerless ones", () => {
    const stats = indexCorpus(db, root, archiveLayout);

    expect(stats).toMatchObject({ documents: 3, indexed: 3, unchanged: 0, removed: 0, skipped: 1, paragraphs: 5 });
  });

  it("re-reads each span from its byte range as the exact paragraph, multibyte text included", () => {
    indexCorpus(db, root, archiveLayout);

    const spans = paragraphsOf("northwind/1/1");
    const texts = spans.map((s) => readSpanText(root, s.relPath, s.byteOffset, s.byteLength));

    expect(texts).toEqual([`${MULTIBYTE} opens the harbour.`, "Second paragraph about lanterns.", `Third, indented, ${MULTIBYTE}.`]);
    const file = readFileSync(path.join(root, "northwind/book_01/chapter_01.txt"));
    expect(spans[2]!.byteOffset).toBeGreaterThan(file.toString("utf8").indexOf("Third"));
  });

  it("finds a paragraph through the contentless index and stores none of its text", () => {
    indexCorpus(db, root, archiveLayout);

    const hits = openSpans(db).search("lanterns", 10);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ownerRef: chapterOwnerRef("northwind/1/1"), field: SPAN_FIELD });
    const stored = JSON.stringify(db.prepare("SELECT * FROM search_span").all()) + JSON.stringify(db.prepare("SELECT * FROM chapter").all());
    expect(stored).not.toContain("lanterns");
  });

  it("does nothing on a second run over unchanged files", () => {
    indexCorpus(db, root, archiveLayout);
    const before = db.prepare("SELECT count(*) AS n FROM search_span").get();

    const stats = indexCorpus(db, root, archiveLayout);

    expect(stats).toMatchObject({ indexed: 0, unchanged: 3, paragraphs: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM search_span").get()).toEqual(before);
  });

  it("re-indexes only the file whose bytes changed, replacing its paragraphs", () => {
    indexCorpus(db, root, archiveLayout);
    writeFile(root, { ...FILES[1]!, body: "Rewritten paragraph, about sundials.\n\nAnd one more.\n" });

    const stats = indexCorpus(db, root, archiveLayout);

    expect(stats).toMatchObject({ indexed: 1, unchanged: 2, paragraphs: 2 });
    const spans = openSpans(db);
    expect(spans.search("kettles", 10)).toHaveLength(0);
    expect(spans.search("sundials", 10)).toHaveLength(1);
    expect(paragraphsOf("northwind/1/2")).toHaveLength(2);
  });

  it("drops a file that vanished from the corpus", () => {
    indexCorpus(db, root, archiveLayout);
    cleanup();
    ({ root, cleanup } = writeCorpus(FILES.filter((f) => !f.relPath.startsWith("other/"))));

    const stats = indexCorpus(db, root, archiveLayout);

    expect(stats.removed).toBe(3 - 2);
    expect(openSpans(db).search("teapots", 10)).toHaveLength(0);
  });
});
