import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { GateAskStore, gateAskMigration } from "./gate-ask-store.js";

function store(): GateAskStore {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateAskMigration()]);
  return new GateAskStore(db, () => Date.parse("2026-10-11T12:00:00Z"));
}

describe("gate ask store", () => {
  it("settles an asked gate once and refuses every later settle", () => {
    const asks = store();
    asks.record("run1/approve-merge", "m1");

    const first = asks.settle("run1/approve-merge", "resolved");
    const second = asks.settle("run1/approve-merge", "dismissed");

    expect([first, second]).toEqual([true, false]);
    expect(asks.byMsg("m1")).toMatchObject({ gateId: "run1/approve-merge", state: "resolved", settledAt: "2026-10-11T12:00:00.000Z" });
  });

  it("refuses a second ask for the same gate", () => {
    const asks = store();
    asks.record("run1/approve-merge", "m1");

    expect(() => asks.record("run1/approve-merge", "m2")).toThrow(/UNIQUE/);
  });

  it("lists only asks still waiting on the owner", () => {
    const asks = store();
    asks.record("run1/a", "m1");
    asks.record("run2/b", "m2");
    asks.settle("run1/a", "unmappable", "maybe");

    expect(asks.open().map((ask) => ask.gateId)).toEqual(["run2/b"]);
    expect(asks.get("run1/a")?.detail).toBe("maybe");
  });

  it("keeps one answers cursor per label and moves it forward", () => {
    const asks = store();

    asks.advance("titan-factory", "m5");
    asks.advance("titan-factory", "m9");

    expect(asks.cursor("titan-factory")).toBe("m9");
    expect(asks.cursor("other")).toBeUndefined();
  });

  it("rolls a settle back when the work in its transaction throws", () => {
    const asks = store();
    asks.record("run1/a", "m1");

    expect(() =>
      asks.atomically(() => {
        asks.settle("run1/a", "resolved");
        throw new Error("resolve failed");
      }),
    ).toThrow("resolve failed");

    expect(asks.get("run1/a")?.state).toBe("asked");
  });
});
