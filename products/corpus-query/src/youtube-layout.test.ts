import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase, type Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chapterOwnerRef, indexCorpus, listChapters, openSpans, readSpanText, SPAN_FIELD } from "./index-corpus.js";
import { LAYOUTS } from "./layout.js";
import { paragraphAnchor, youtubeLayout } from "./youtube-layout.js";

const FRONT = `---\ntitle: "Invented talk on kettles"\nchannel: Example Channel\nposted: 2026-10-01\nduration: 600\nid: vidAAA00001\n---\n\n`;
const TRANSCRIPT = `${FRONT}[00:00] Opening remarks about lanterns.\n\n[01:05] Middle part on sundials.\n\n[12:30] Closing thoughts.\n`;
const FILES: Record<string, string> = {
  "example/vidAAA00001.md": TRANSCRIPT,
  "example/vidAAA00001.score.json": '{\n  "total": 11,\n  "summary": "teapots"\n}\n',
  "example/vidAAA00001.digest.md": "# Digest\n\nKey claim about barometers.\n",
  "example/notes.txt": "ignored",
};

let root: string;
let db: Db;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "corpus-query-yt-"));
  for (const [rel, body] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  db = openDatabase(":memory:");
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("youtube layout", () => {
  it("is selectable by name", () => {
    expect(LAYOUTS.youtube).toBe(youtubeLayout);
  });

  it("reads title, channel handle, posted date and the video id as ref from the front matter", () => {
    const meta = youtubeLayout.describe("example/vidAAA00001.md", TRANSCRIPT);

    expect(meta).toMatchObject({ id: "vidAAA00001", ref: "vidAAA00001", title: "Invented talk on kettles", series: "example", published: "2026-10-01" });
  });

  it("joins score and digest siblings to the transcript's ref under their own ids", () => {
    const score = youtubeLayout.describe("example/vidAAA00001.score.json", FILES["example/vidAAA00001.score.json"]!);
    const digest = youtubeLayout.describe("example/vidAAA00001.digest.md", FILES["example/vidAAA00001.digest.md"]!);

    expect([score?.ref, digest?.ref]).toEqual(["vidAAA00001", "vidAAA00001"]);
    expect([score?.id, digest?.id]).toEqual(["vidAAA00001.score", "vidAAA00001.digest"]);
  });

  it("skips files that are not transcripts or siblings", () => {
    expect(youtubeLayout.describe("example/notes.txt", "x")).toBeUndefined();
  });

  it("reads [mm:ss] as seconds and none as undefined", () => {
    expect(paragraphAnchor("[01:05] text")).toBe(65);
    expect(paragraphAnchor("[00:00] text")).toBe(0);
    expect(paragraphAnchor("no anchor")).toBeUndefined();
  });
});

describe("indexing the youtube layout", () => {
  const paragraphTexts = (id: string): string[] =>
    db
      .prepare<[string, string], { o: number; l: number; p: string }>("SELECT s.byte_offset AS o, s.byte_length AS l, c.rel_path AS p FROM search_span s JOIN chapter c ON c.source_id = s.source_id WHERE s.owner_ref = ? AND s.field = ? ORDER BY s.byte_offset")
      .all(chapterOwnerRef(id), SPAN_FIELD)
      .map((r) => readSpanText(root, r.p, r.o, r.l));

  it("indexes front-matter-free paragraphs whose anchors are the locators", () => {
    const stats = indexCorpus(db, root, youtubeLayout);

    expect(stats).toMatchObject({ documents: 3, indexed: 3, skipped: 1, removed: 0 });
    const texts = paragraphTexts("vidAAA00001");
    expect(texts.map(paragraphAnchor)).toEqual([0, 65, 750]);
    expect(texts.join("\n")).not.toContain("channel:");
  });

  it("finds sibling content and lists all three documents under one ref", () => {
    indexCorpus(db, root, youtubeLayout);

    expect(openSpans(db).search("barometers", 10)[0]?.ownerRef).toBe(chapterOwnerRef("vidAAA00001.digest"));
    expect(new Set(listChapters(db).map((c) => c.ref))).toEqual(new Set(["vidAAA00001"]));
  });

  it("reports every file unchanged on a second run", () => {
    indexCorpus(db, root, youtubeLayout);

    expect(indexCorpus(db, root, youtubeLayout)).toMatchObject({ indexed: 0, unchanged: 3, removed: 0, paragraphs: 0 });
  });

  it("counts a removed file in removed and drops its text", () => {
    indexCorpus(db, root, youtubeLayout);
    unlinkSync(path.join(root, "example/vidAAA00001.digest.md"));

    const stats = indexCorpus(db, root, youtubeLayout);

    expect(stats).toMatchObject({ removed: 1, unchanged: 2 });
    expect(openSpans(db).search("barometers", 10)).toHaveLength(0);
  });
});
