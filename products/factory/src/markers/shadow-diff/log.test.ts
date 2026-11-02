import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import type { MarkerRow } from "../marker-store.js";
import { swallow, type ShadowEvent } from "../shadow.js";
import type { Verdict } from "../validity.js";
import { fullAndMaterial, logSink, readLog, shadowLogMigration } from "./log.js";

const AT = "2026-11-02T12:00:00.000Z";
const SITE = { runId: "run-1", stepId: "ci-wait", fact: "ci:green", memoKey: "seed:ci-wait:0" };
const COUNTERS = { replayed: 1, evaluations: 3, shadowMs: 4 };

const marker: MarkerRow = {
  id: 7,
  item: "o/r#7",
  fact: "ci:green",
  pinClass: "tree",
  pin: `${"a".repeat(40)}@e1`,
  pinSeq: 1,
  expiresAt: null,
  step: "ci-wait",
  callSite: "land/ci-wait",
  version: "v1",
  inputDigests: {},
  reads: [],
  outputDigest: "sha256:o",
  projectionDigest: "sha256:p",
  runId: "run-0",
  memoKey: "seed:ci-wait:0",
  reverted: false,
  writtenAt: AT,
};

const valid = (drift: string[]): Verdict => ({ status: "valid", marker, digests: { projection: "sha256:p", output: "sha256:o" }, drift });
const inputChanged: Verdict = { status: "absent", reason: "input-changed", detail: "head:pushed", inputs: [] };
const orphan: ShadowEvent = { ...SITE, kind: "call-site-orphan", marker, callSite: "land/ci-wait", failClosed: true };

function memory(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [shadowLogMigration()]);
  return db;
}

const rows = (db: Db) => readLog(db, { sinceIso: AT });

describe("shadow disagreement log", () => {
  it("every shadow event kind is written as one log row", () => {
    const db = memory();
    const sink = logSink(db, () => AT);
    const events: ShadowEvent[] = [
      { ...SITE, kind: "verdict", verdict: valid([]), wouldFastForward: true, unreplayable: [] },
      { ...SITE, kind: "shadow-error", error: "boom" },
      orphan,
      { ...SITE, kind: "budget-exceeded", counters: COUNTERS },
      { ...SITE, stepId: "", fact: "", memoKey: "", kind: "entry-end", counters: COUNTERS },
      { ...SITE, memoKey: "", kind: "not-after-skip", notAfter: "ci:green" },
      { ...SITE, memoKey: "", kind: "advisory" },
    ];

    for (const event of events) sink(event);

    expect(rows(db).map(({ kind, family, markerId, detail }) => ({ kind, family, markerId, detail }))).toEqual([
      { kind: "verdict", family: "tree", markerId: 7, detail: { wouldFastForward: true, unreplayable: [] } },
      { kind: "shadow-error", family: "tree", markerId: null, detail: { error: "boom" } },
      { kind: "call-site-orphan", family: "tree", markerId: 7, detail: { callSite: "land/ci-wait", failClosed: true } },
      { kind: "budget-exceeded", family: "tree", markerId: null, detail: { counters: COUNTERS } },
      { kind: "entry-end", family: null, markerId: null, detail: { counters: COUNTERS } },
      { kind: "not-after-skip", family: "tree", markerId: null, detail: { notAfter: "ci:green" } },
      { kind: "advisory", family: "tree", markerId: null, detail: {} },
    ]);
  });

  it("a verdict with drift is material-valid and not full-valid; an input-changed verdict is neither", () => {
    const db = memory();
    const sink = logSink(db, () => AT);

    sink({ ...SITE, kind: "verdict", verdict: valid(["head:pushed"]), wouldFastForward: true, unreplayable: [] });
    sink({ ...SITE, kind: "verdict", verdict: inputChanged, wouldFastForward: false, unreplayable: [] });

    expect(fullAndMaterial(valid([]))).toEqual({ materialValid: true, fullValid: true, drift: [] });
    expect(rows(db).map(({ materialValid, fullValid, drift }) => ({ materialValid, fullValid, drift }))).toEqual([
      { materialValid: true, fullValid: false, drift: ["head:pushed"] },
      { materialValid: false, fullValid: false, drift: [] },
    ]);
    expect(rows(db)[1]?.detail).toMatchObject({ reason: "input-changed", reasonDetail: "head:pushed" });
  });

  it("the same call-site-orphan sent twice, across two sink instances on one database, writes one row", () => {
    const db = memory();

    logSink(db, () => AT)(orphan);
    logSink(db, () => AT)(orphan);

    expect(rows(db).filter((row) => row.kind === "call-site-orphan")).toHaveLength(1);
  });

  it("the log refuses update and delete", () => {
    const db = memory();
    logSink(db, () => AT)({ ...SITE, kind: "shadow-error", error: "boom" });

    expect(() => db.prepare("UPDATE factory_shadow_log SET kind = 'advisory'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM factory_shadow_log").run()).toThrow(/append-only/);
    expect(rows(db)).toHaveLength(1);
  });

  it("a sink write that throws never reaches the caller", async () => {
    const db = memory();
    const sink = logSink(db, () => AT);
    db.close();

    const outcome = swallow({ sink }, SITE, () => {
      throw new Error("shadow failed");
    });

    await expect(outcome).resolves.toBeUndefined();
  });
});
