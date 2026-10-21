import path from "node:path";
import { openDatabase } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { writeCorpus } from "./synthetic-corpus.test-helpers.js";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe("corpus-query index", () => {
  it("indexes a corpus into the named database and prints counts", async () => {
    const corpus = writeCorpus([{ relPath: "solo/book_01/chapter_01.txt", title: "SO 1.1 - Hi", published: "2026-01-01", body: "One.\n\nTwo.\n" }]);
    cleanup = corpus.cleanup;
    const db = path.join(corpus.root, "..", `${path.basename(corpus.root)}.sqlite3`);
    const lines: string[] = [];

    const code = await runCli(["index", corpus.root, "--db", db], (l) => lines.push(l));

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("documents 1, indexed 1");
    const opened = openDatabase(db, { readonly: true });
    expect(opened.prepare("SELECT paragraph_count AS n FROM chapter").get()).toEqual({ n: 2 });
    opened.close();
  });

  it("rejects an unknown layout with a usage exit code", async () => {
    const code = await runCli(["index", ".", "--layout", "nope"], () => undefined);

    expect(code).toBe(2);
  });
});
