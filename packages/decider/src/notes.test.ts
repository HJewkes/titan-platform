import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractSource } from "./extract.js";
import { POLICY } from "./fixtures.js";
import { LedgerRowSchema, type LedgerRowWire } from "./ledger.js";
import { noteKey, noteSource } from "./notes.js";
import { openLedgerStore, type LedgerStore } from "./store.js";

/** Synthetic notes only: invented initiatives, titles and bodies. */

const IMPORTED = "\n---\nImported 2026-01-03 from Claude Code memory (type: feedback, file: no-wrap.md)";

let root: string;
let store: LedgerStore;

function writeNote(slug: string, file: string, frontmatter: string, body: string): string {
  const dir = path.join(root, slug, "sources", "notes");
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, file);
  writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}\n`, "utf8");
  return filePath;
}

function writeFixture(): void {
  writeNote("widgets", "2026-01-01-queue.md", "kind: decision\ntitle: Approach for the widget refresh is a queue\ncreated: '2026-01-01'", "Cron drifts; the queue retries.");
  writeNote("widgets", "2026-01-02-no-wrap.md", "kind: fyi\ntitle: Do not offer to wrap\ncreated: 2026-01-02\ntags:\n  - memory-import\n  - feedback", "Keep going while work exists.");
  writeNote("widgets", "2026-01-03-trailer.md", "kind: fyi\ntitle: 'Merge PR #12 only when green'\ncreated: '2026-01-03'\ntags: [memory-import]", `Wait for CI.${IMPORTED}`);
  writeNote("widgets", "2026-01-04-fact.md", "kind: fyi\ntitle: Project fact\ncreated: '2026-01-04'\ntags: [memory-import, project]", "Not a precedent.");
  writeNote("widgets", "2026-01-05-gotcha.md", "kind: gotcha\ntitle: A plain gotcha\ncreated: '2026-01-05'", "Not a precedent either.");
}

/** What active-work's `notes.ts` writes to `precedents.jsonl` for the fixture's first note. */
function activeWorkV1Row(): LedgerRowWire {
  return {
    key: "note:widgets/2026-01-01-queue.md",
    source: "note",
    asked_at: "2026-01-01",
    session_id: null,
    tool_use_id: null,
    initiative: "widgets",
    class: "tech_design",
    header: null,
    question: "Approach for the widget refresh is a queue",
    options: [],
    recommended: null,
    answer: "Cron drifts; the queue retries.",
    pick_type: "none",
    free_text: null,
  };
}

function extract() {
  return extractSource(store, noteSource({ root }), POLICY);
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "decider-notes-"));
  store = openLedgerStore(":memory:");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("note source", () => {
  it("writes decision notes and feedback imports, and skips every other note", async () => {
    writeFixture();

    const summary = await extract();

    expect(summary).toMatchObject({ read: 3, written: 3, errors: [] });
    expect(store.rows().map((r) => r.question)).toEqual([
      "Approach for the widget refresh is a queue",
      "Do not offer to wrap",
      "Merge PR #12 only when green",
    ]);
  });

  it("matches the row active-work wrote for the same note, so v1 rows dedupe with it", async () => {
    writeFixture();
    const v1 = LedgerRowSchema.parse(activeWorkV1Row());

    await extract();
    const row = store.get(noteKey("widgets", "2026-01-01-queue.md"));

    const { key, source, asked_at, initiative, category, header, question, options, recommended, answer, outcome } = v1;
    expect(row).toMatchObject({ key, source, asked_at, initiative, category, header, question, options, recommended, answer, outcome });
    expect(row).toMatchObject({ v: 2, outcome: "none", unclaimed: false });
  });

  it("writes nothing over a ledger that already holds active-work's v1 row", async () => {
    writeNote("widgets", "2026-01-01-queue.md", "kind: decision\ntitle: Approach for the widget refresh is a queue\ncreated: '2026-01-01'", "Cron drifts; the queue retries.");
    store.append([activeWorkV1Row()]);

    const summary = await extract();

    expect(summary).toMatchObject({ read: 1, written: 0, alreadyIndexed: 1 });
  });

  it("strips the memory-import trailer from the answer and classifies by title", async () => {
    writeFixture();

    await extract();

    expect(store.get(noteKey("widgets", "2026-01-03-trailer.md"))).toMatchObject({
      answer: "Wait for CI.",
      category: "merge_gate",
      asked_at: "2026-01-03",
    });
  });

  it("writes nothing new when extraction runs again over the same notes", async () => {
    writeFixture();
    await extract();

    const again = await extract();

    expect(again).toMatchObject({ read: 0, written: 0, alreadyIndexed: 0 });
    expect(store.count()).toBe(3);
  });

  it("re-reads only the note whose content changed", async () => {
    writeFixture();
    await extract();
    writeNote("widgets", "2026-01-05-gotcha.md", "kind: decision\ntitle: A settled gotcha\ncreated: '2026-01-05'", "Now a decision.");

    const second = await extract();

    expect(second).toMatchObject({ read: 1, written: 1 });
    expect(store.count()).toBe(4);
  });

  it("never writes a note from a human-only initiative, nor one that names a listed person", async () => {
    writeNote("garden-diary", "2026-01-01-beds.md", "kind: decision\ntitle: Raise the beds\ncreated: '2026-01-01'", "Do it in spring.");
    writeNote("widgets", "2026-01-02-ask.md", "kind: decision\ntitle: Who reviews widgets\ncreated: '2026-01-02'", "Ask Zorblat.");

    const summary = await extract();
    const again = await extract();

    expect(summary.excluded).toEqual({ "human-only-initiative": 1, "human-only-cwd": 0, "personal-data": 1 });
    expect([summary.written, again.read, store.count()]).toEqual([0, 0, 0]);
  });

  it("reports a malformed note once and keeps reading the rest", async () => {
    const bad = writeNote("widgets", "2026-01-00-bad.md", "kind: decision\ntitle: No date", "Body.");
    writeFixture();

    const summary = await extract();
    const again = await extract();

    expect(summary.errors).toEqual([expect.stringContaining(bad)]);
    expect(summary.written).toBe(3);
    expect(again.errors).toEqual([]);
  });

  it("reads nothing from a root that does not exist", async () => {
    rmSync(root, { recursive: true, force: true });

    const summary = await extract();

    expect(summary).toMatchObject({ read: 0, written: 0, errors: [] });
  });
});
