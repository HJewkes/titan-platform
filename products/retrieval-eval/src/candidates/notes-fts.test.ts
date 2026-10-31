import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SpanFtsTables, openDatabase, spanFtsTablesDdl } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { notesFts } from "./notes-fts.js";

const LEGACY_SOURCE_ID = 1_000_000_001;
let dir: string;
let graphPath: string;

function span(ownerRef: string, sourceId: number) {
  return { ownerRef, field: "body", sourceId, byteOffset: 0, byteLength: 10 };
}

/** Index into whichever tables `options` names, then close, as the miner would. */
function seed(options: { name: string; contentlessDelete?: boolean }, rows: [string, number, string][]): void {
  const db = openDatabase(graphPath);
  try {
    db.exec(spanFtsTablesDdl(options));
    const spans = new SpanFtsTables(db, options);
    for (const [owner, sourceId, text] of rows) spans.index(span(owner, sourceId), text);
  } finally {
    db.close();
  }
}

async function ownersFor(query: string): Promise<string[]> {
  const candidate = notesFts({ graphPath, activeRoot: dir });
  try {
    return (await candidate.search(query, 10, { arm: "spawn" })).map((hit) => hit.id);
  } finally {
    candidate.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "notes-fts-"));
  graphPath = path.join(dir, "graph.sqlite3");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("notesFts across the workspace span cutover", () => {
  it("finds a note in the workspace table once the graph has flipped", async () => {
    seed({ name: "search" }, [["session:s1", 1, "zebra transcript text"]]);
    seed({ name: "workspace", contentlessDelete: true }, [["note:a/one.md", LEGACY_SOURCE_ID, "zebra lesson"]]);

    expect(await ownersFor("zebra")).toEqual(["note:a/one.md"]);
  });

  it("finds a note in the shared table on a graph that has no workspace table", async () => {
    seed({ name: "search" }, [["note:a/one.md", LEGACY_SOURCE_ID, "zebra lesson"]]);

    expect(await ownersFor("zebra")).toEqual(["note:a/one.md"]);
  });

  it("stays on the shared table while a backfill has copied only some notes", async () => {
    seed({ name: "search" }, [
      ["note:a/one.md", LEGACY_SOURCE_ID, "zebra lesson"],
      ["note:a/two.md", LEGACY_SOURCE_ID + 1, "zebra again"],
    ]);
    seed({ name: "workspace", contentlessDelete: true }, [["note:a/one.md", LEGACY_SOURCE_ID, "zebra lesson"]]);

    expect((await ownersFor("zebra")).sort()).toEqual(["note:a/one.md", "note:a/two.md"]);
  });

  it("returns no transcript owners from the workspace table", async () => {
    seed({ name: "search" }, [["note:a/one.md", 1, "zebra"]]);
    seed({ name: "workspace", contentlessDelete: true }, [["note:b/two.md", LEGACY_SOURCE_ID, "zebra"]]);

    expect(await ownersFor("zebra")).toEqual(["note:b/two.md"]);
  });
});
