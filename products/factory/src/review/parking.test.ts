import type { ParkedRun } from "@titan-design/review-workflow";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { reviewParkingMigration, sqliteParking } from "./parking.js";

const run = (runId: string, fingerprint: string): ParkedRun => ({ runId, target: { repo: "acme/widgets", pr: 7, head: "a".repeat(40) }, fingerprint, failure: "start-refused:profile" });

describe("sqliteParking", () => {
  it("hands a later process every run parked on a fingerprint once, and counts the release", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [reviewParkingMigration(1)]);
    const first = sqliteParking(db);
    await first.park(run("run-1", "fp-a"));
    await first.park(run("run-1", "fp-a"));
    await first.park(run("run-2", "fp-b"));

    const later = sqliteParking(db);
    const released = await later.release("fp-a");

    expect([released, await later.parked("fp-a"), await later.parked("fp-b"), await later.round("fp-a")]).toEqual([[run("run-1", "fp-a")], [], [run("run-2", "fp-b")], 1]);
  });
});
