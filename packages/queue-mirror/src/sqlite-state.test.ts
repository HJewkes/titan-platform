import { openDatabase } from "@titan-design/store-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteMirrorState } from "./sqlite-state.js";
import { runMirrorStateConformance } from "./state-conformance.js";
import type { PostedItem } from "./types.js";

const posted = (sourceId: string): PostedItem => ({
  sourceId,
  eventId: `$${sourceId}`,
  kind: "approval_request",
  approvable: true,
  status: "open",
  record: { v: 1, kind: "approval_request", machine: "m", session: "s", msg_id: sourceId, at: 1, truncated: false, redacted: false },
});

runMirrorStateConformance("SqliteMirrorState", () => new SqliteMirrorState(openDatabase(":memory:")));

describe("SqliteMirrorState", () => {
  it("leaves no partial rows when a commit fails partway through", () => {
    const state = new SqliteMirrorState(openDatabase(":memory:"));
    const duplicateEventId: PostedItem = { ...posted("b"), eventId: "$a" };

    expect(() => state.commit({ posted: [posted("a"), duplicateEventId] })).toThrow();

    expect(state.bySourceId("a")).toBeUndefined();
    expect(state.bySourceId("b")).toBeUndefined();
    expect(state.openItems()).toEqual([]);
  });

  it("round-trips hasApplied across a reopen of the same file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "queue-mirror-"));
    const dbPath = path.join(dir, "mirror.sqlite3");
    try {
      const db = openDatabase(dbPath);
      new SqliteMirrorState(db).commit({ applied: ["$r"] });
      db.close();

      const reopened = new SqliteMirrorState(openDatabase(dbPath));

      expect(reopened.hasApplied("$r")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
