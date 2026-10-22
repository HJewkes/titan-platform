import { openDatabase, type Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMatch } from "./match.js";
import { displayRef } from "./display-ref.js";
import { indexCorpus } from "./index-corpus.js";
import { archiveLayout } from "./layout.js";
import { readPassage, retrieve } from "./retrieve.js";
import { writeCorpus, writeFile, type SyntheticFile } from "./synthetic-corpus.test-helpers.js";

const filler = (n: number): string => Array.from({ length: n }, (_, i) => `Filler line ${i} about nothing.`).join("\n\n");

const FILES: SyntheticFile[] = [
  {
    relPath: "harbour-masters/book_01/chapter_01.txt",
    title: "HM 1.1 - Start",
    published: "2026-01-01",
    // paragraphs 0..: cup+won at 2, cup alone at 5, won alone at 6, cup+won at 9 and 10, then filler
    body: ["Intro.", "Mist.", "The lantern cup was won today.", "Calm.", "Calm.", "A lantern cup stood on the shelf.", "Everyone won at cards.", "Calm.", "Calm.", "The kettle trophy was claimed, again.", "Another kettle trophy was won!", filler(8)].join("\n\n"),
  },
  { relPath: "harbour-masters/book_01/chapter_02.txt", title: "1.2 - Restart", published: "2026-01-02", body: "A kettle trophy won here.\n\nTail.\n" },
  { relPath: "tide-of-fortune/book_01/chapter_01.txt", title: "1.1 - Restart", published: "2026-01-03", body: "A kettle trophy won there.\n" },
];

let db: Db;
let cleanup: () => void;
let root: string;

beforeEach(() => {
  ({ root, cleanup } = writeCorpus(FILES));
  db = openDatabase(":memory:");
  indexCorpus(db, root, archiveLayout);
});
afterEach(() => {
  db.close();
  cleanup();
});

const CUP_AND_WON = { termGroups: [["lantern*", "kettle"], ["won", "claimed"]] };

describe("retrieve", () => {
  it("matches only paragraphs holding a term from every group", () => {
    const { passages, hitParagraphs } = retrieve(db, { termGroups: [["lantern"], ["won"]] }, { window: 0 });

    expect(hitParagraphs).toBe(1);
    expect(passages.map((p) => [p.firstParagraph, p.lastParagraph])).toEqual([[2, 2]]);
  });

  it("merges overlapping windows in one chapter into a single passage", () => {
    const { passages } = retrieve(db, CUP_AND_WON, { window: 2 });

    const first = passages.filter((p) => p.chapterId === "harbour-masters/1/1");
    // hits at 2, 9, 10: windows 0-4, 7-11 and 8-12 merge to 7-12
    expect(first.map((p) => [p.firstParagraph, p.lastParagraph])).toEqual([[0, 4], [7, 12]]);
  });

  it("keeps passage ids identical when the corpus is re-indexed unchanged", () => {
    const before = retrieve(db, CUP_AND_WON).passages.map((p) => p.id);

    indexCorpus(db, root, archiveLayout);
    const fresh = openDatabase(":memory:");
    indexCorpus(fresh, root, archiveLayout);

    expect(retrieve(db, CUP_AND_WON).passages.map((p) => p.id)).toEqual(before);
    expect(retrieve(fresh, CUP_AND_WON).passages.map((p) => p.id)).toEqual(before);
    fresh.close();
  });

  it("changes a passage id when its file changes", () => {
    const before = retrieve(db, CUP_AND_WON).passages.map((p) => p.id);

    writeFile(root, { ...FILES[1]!, body: `${FILES[1]!.body}\nMore.\n` });
    indexCorpus(db, root, archiveLayout);

    expect(retrieve(db, CUP_AND_WON).passages.map((p) => p.id)).not.toEqual(before);
  });

  it("builds ids from the chapter id, so a title code shared by two series stays distinct", () => {
    const { passages } = retrieve(db, { phrases: ["kettle trophy won"] }, { window: 0 });

    const shared = passages.filter((p) => p.chapterId !== "harbour-masters/1/1");
    expect(new Set(shared.map((p) => p.id)).size).toBe(2);
    expect(shared.map((p) => p.id.split("#")[0]).sort()).toEqual(["harbour-masters/1/2", "tide-of-fortune/1/1"]);
    expect(shared.map((p) => p.ref).sort()).toEqual(["HM 1.2", "ToF 1.1"]);
  });

  it("returns passages in story order across series", () => {
    const { passages } = retrieve(db, { phrases: ["kettle trophy"] }, { window: 0 });

    expect(passages.map((p) => p.chapterId)).toEqual(["harbour-masters/1/1", "harbour-masters/1/1", "harbour-masters/1/2", "tide-of-fortune/1/1"]);
  });

  it("leaves out passages listed in excludeIds", () => {
    const all = retrieve(db, CUP_AND_WON).passages;

    const rest = retrieve(db, CUP_AND_WON, { excludeIds: new Set([all[0]!.id]) }).passages;

    expect(rest.map((p) => p.id)).toEqual(all.slice(1).map((p) => p.id));
  });

  it("re-reads a passage's paragraphs from the file", () => {
    const [first] = retrieve(db, { termGroups: [["lantern"], ["won"]] }, { window: 1 }).passages;

    expect(readPassage(db, root, first!)).toEqual(["Mist.", "The lantern cup was won today.", "Calm."]);
  });
});

describe("buildMatch", () => {
  it("joins term groups with AND and the terms within a group with OR", () => {
    expect(buildMatch({ termGroups: [["cup", "promot*"], ["won"]] })).toBe('(("cup" OR "promot"*) AND "won")');
  });

  it("survives punctuation that is FTS syntax", () => {
    const hostile = ['cup" OR (', "NEAR(a b)", "a:b", "-x", "***", "won)"];
    const expression = buildMatch({ termGroups: [hostile], phrases: ['say "hi'] });

    expect(() => db.prepare("SELECT rowid FROM search_fts WHERE search_fts MATCH ?").all(expression)).not.toThrow();
    expect(() => retrieve(db, { termGroups: [hostile] })).not.toThrow();
  });

  it("drops a group with no usable term instead of matching everything", () => {
    expect(buildMatch({ termGroups: [["cup"], ["***", '""']] })).toBe('"cup"');
  });

  it("refuses a query with nothing to search for", () => {
    expect(() => buildMatch({ termGroups: [["!!"]] })).toThrow(/no searchable terms/);
  });
});

describe("displayRef", () => {
  it("prefixes the title code with the series, keeping small words lower-case", () => {
    expect(displayRef({ id: "x/1/1", ref: "7.15", series: "harbour-masters" })).toBe("HM 7.15");
    expect(displayRef({ id: "x/1/1", ref: "1.9", series: "tide-of-fortune" })).toBe("ToF 1.9");
  });

  it("leaves a code that already carries its own prefix, an id fallback, or a document outside a series alone", () => {
    expect(displayRef({ id: "x/1/1", ref: "TF 1.9", series: "tide-of-fortune" })).toBe("TF 1.9");
    expect(displayRef({ id: "a/1/1", ref: "a/1/1", series: "a" })).toBe("a/1/1");
    expect(displayRef({ id: "other/x", ref: "Notice 3", series: "other" })).toBe("Notice 3");
  });
});
