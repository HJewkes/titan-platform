import { describe, expect, it } from "vitest";
import { archiveLayout, plainLayout } from "./layout.js";
import { compareStoryOrder } from "./story-order.js";
import type { ChapterMeta } from "./types.js";

const header = (title: string, published = "2026-01-02") => `TITLE: ${title}\nPUBLISHED: ${published}\nPOST_ID: 42\n\nBody.\n`;

function describeArchive(relPath: string, title = "AA 1.1 - Opening"): ChapterMeta {
  const meta = archiveLayout.describe(relPath, header(title));
  if (!meta) throw new Error(`layout rejected ${relPath}`);
  return meta;
}

describe("archive layout", () => {
  it("reads series, book and chapter from the path and the ref from the TITLE code", () => {
    const meta = describeArchive("northwind/book_03/chapter_12.txt", "NW 3.12 - The Long Road [T1]");

    expect(meta).toMatchObject({
      series: "northwind",
      book: 3,
      chapter: 12,
      ref: "NW 3.12",
      title: "The Long Road [T1]",
      published: "2026-01-02",
      postId: "42",
    });
    expect(meta.preseason).toBeUndefined();
  });

  it("keeps preseason posts distinct from each other and from chapter 0 proper", () => {
    const a = describeArchive("player-manager/book_02/chapter_00_preseason_1.txt");
    const b = describeArchive("player-manager/book_02/chapter_00_preseason_2.txt");

    expect(a.preseason).toBe(1);
    expect(b.preseason).toBe(2);
    expect(new Set([a.id, b.id]).size).toBe(2);
  });

  it("files other/ posts under series other, dated from the header", () => {
    const meta = describeArchive("other/2026-03-09_A-Short-Break.txt", "A Short Break");

    expect(meta).toMatchObject({ series: "other", published: "2026-01-02", ref: "other/2026-03-09_A-Short-Break" });
  });

  it("falls back to the date in an other/ filename when the header has none", () => {
    const meta = archiveLayout.describe("other/2026-03-09_Note.txt", "Just prose.\n");

    expect(meta?.published).toBe("2026-03-09");
    expect(meta?.title).toBe("");
  });

  it("skips files that are not archive documents", () => {
    expect(archiveLayout.describe("notes/readme.md", "x")).toBeUndefined();
    expect(archiveLayout.describe("northwind/book_one/chapter_1.txt", "x")).toBeUndefined();
  });
});

describe("story order", () => {
  const order = (relPath: string, published?: string) => {
    const meta = archiveLayout.describe(relPath, header("X 1.1 - T", published));
    return meta!.order;
  };

  it("runs player-manager, soccer-supremo, dof, then other by publish date", () => {
    const shuffled = [
      order("other/2026-05-01_B.txt", "2026-05-01"),
      order("dof/book_01/chapter_01.txt"),
      order("other/2026-02-01_A.txt", "2026-02-01"),
      order("soccer-supremo/book_01/chapter_01.txt"),
      order("player-manager/book_09/chapter_30.txt"),
    ];

    const sorted = [...shuffled].sort(compareStoryOrder);

    expect(sorted.map((k) => k[1])).toEqual([0, 1, 2, "2026-02-01", "2026-05-01"]);
  });

  it("orders by book before chapter, numerically", () => {
    const keys = ["book_10/chapter_01", "book_2/chapter_11", "book_2/chapter_02"].map((p) => order(`player-manager/${p}.txt`));

    const sorted = [...keys].sort(compareStoryOrder);

    expect(sorted.map((k) => [k[3], k[4]])).toEqual([[2, 2], [2, 11], [10, 1]]);
  });

  it("puts preseason posts before chapter 1 of the same book, by number", () => {
    const paths = ["chapter_01", "chapter_00_preseason_2", "chapter_00_preseason_1"];

    const sorted = paths.map((p) => order(`player-manager/book_03/${p}.txt`)).sort(compareStoryOrder);

    expect(sorted.map((k) => [k[4], k[5]])).toEqual([[0, 1], [0, 2], [1, 0]]);
  });

  it("sorts a series it has no rank for after the known ones, by name", () => {
    const keys = [order("zeta/book_01/chapter_01.txt"), order("alpha/book_01/chapter_01.txt"), order("dof/book_01/chapter_01.txt")];

    const sorted = [...keys].sort(compareStoryOrder);

    expect(sorted.map((k) => k[2])).toEqual(["dof", "alpha", "zeta"]);
  });
});

describe("plain layout", () => {
  it("treats a headerless text file as one document keyed by its path", () => {
    const meta = plainLayout.describe("essays/one.txt", "Just a paragraph.\n");

    expect(meta).toMatchObject({ id: "essays/one.txt", ref: "essays/one.txt", title: "", series: "essays" });
  });

  it("uses header lines when present and skips non-text files", () => {
    expect(plainLayout.describe("a.txt", header("EX 1 - Hello"))?.ref).toBe("EX 1");
    expect(plainLayout.describe("a.bin", "x")).toBeUndefined();
  });
});
