import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("corpus-query cost", () => {
  it("prints the folded cost of a run against the baseline", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cq-cost-"));
    mkdirSync(path.join(dir, "run1"));
    writeFileSync(path.join(dir, "run1", "cost.json"), JSON.stringify([{ stage: "screen", model: "claude-haiku-5-5", inputTokens: 1000, cacheWrite1hTokens: 500 }]));
    const lines: string[] = [];

    const code = await runCli(["cost", "run1", "--runs-dir", dir], (l) => lines.push(l));
    rmSync(dir, { recursive: true });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("cache write 1h 500");
    expect(lines.join("\n")).toContain("of $19.10 baseline");
  });
});
