import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { parseNumberFlag, RULES } from "./workflow/commands.js";
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

describe("corpus-query hits", () => {
  const files = [{ relPath: "solo/book_01/chapter_01.txt", title: "SO 1.1 - Hi", published: "2026-01-01", body: "Quiet.\n\nThe brass bell rang twice.\n\nQuiet again.\n\nQuiet still.\n\nQuiet more.\n" }];

  async function indexed(): Promise<{ root: string; db: string }> {
    const corpus = writeCorpus(files);
    cleanup = corpus.cleanup;
    const db = path.join(corpus.root, "..", `${path.basename(corpus.root)}.sqlite3`);
    await runCli(["index", corpus.root, "--db", db], () => undefined);
    return { root: corpus.root, db };
  }

  it("prints ref, locator and context for each passage without any model", async () => {
    const { root, db } = await indexed();
    const lines: string[] = [];

    const code = await runCli(["hits", root, "--db", db, "--phrase", "brass bell"], (l) => lines.push(l));

    expect(code).toBe(0);
    expect(lines).toEqual(["SO 1.1 | p0-3 | Quiet. ¶ The brass bell rang twice. ¶ Quiet again. ¶ Quiet still."]);
  });

  it("prints counts only with --summary", async () => {
    const { root, db } = await indexed();
    const lines: string[] = [];

    await runCli(["hits", root, "--db", db, "--phrase", "brass bell", "--window", "0", "--summary"], (l) => lines.push(l));

    expect(lines).toEqual(["hit paragraphs 1, passages 1, chapters 1"]);
  });

  it("requires exactly one of --spec and --phrase", async () => {
    const { root, db } = await indexed();

    expect(await runCli(["hits", root, "--db", db], () => undefined)).toBe(2);
  });
});

describe("corpus-query ask flags", () => {
  const ask = (...flags: string[]) => {
    const lines: string[] = [];
    return runCli(["ask", "List every cup", "--corpus", ".", ...flags], (l) => lines.push(l)).then((code) => ({ code, out: lines.join("\n") }));
  };

  it.each([
    ["--rounds", "abc"], ["--rounds", ""], ["--rounds", "-1"], ["--rounds", "1.5"], ["--rounds", "11"], ["--rounds", "Infinity"],
    ["--concurrency", "0"], ["--concurrency", "2.5"], ["--concurrency", "33"], ["--concurrency", "NaN"],
    ["--budget-usd", "0"], ["--budget-usd", "-3"], ["--budget-usd", "Infinity"], ["--budget-usd", "1001"], ["--budget-usd", "three"],
  ])("rejects %s %s before any run starts, naming the flag", async (flag, value) => {
    const { code, out } = await ask(flag, value);

    expect(code).not.toBe(0);
    expect(out).toContain(flag);
  });

  it("accepts a fractional budget and zero rounds", () => {
    expect(parseNumberFlag(RULES.budgetUsd, "0.5")).toBe(0.5);
    expect(parseNumberFlag(RULES.rounds, "0")).toBe(0);
  });
});
