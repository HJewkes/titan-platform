import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { IllegalPhaseEdgeError } from "./claim-phase.js";
import { LedgerMalformedError, exportLedgerJson } from "./json.js";
import type { Claim, Ledger } from "./schema.js";
import { StaleRevisionError, importLedgerJson, type LedgerStore } from "./store.js";

export const FIXTURE = fs.readFileSync(new URL("./fixtures/burndown-ledger.json", import.meta.url), "utf8");

type MakeStore = () => LedgerStore;

const queued = (taskId: string): Claim => ({
  taskId,
  initiative: "demo",
  spawnedAt: "2026-01-01T10:00:00.000Z",
  phase: "queued",
  phaseAt: "2026-01-01T10:00:00.000Z",
});

const ledgerOf = (...claims: Claim[]): Ledger => ({ version: 1, claims });

/** The `LedgerStore` contract, run over each adapter; `make` returns an empty store. */
export function describeLedgerStore(name: string, make: MakeStore): void {
  describe(`${name} LedgerStore contract`, () => {
    revisionCases(make);
    refusalCases(make);
    normalizingCases(make);
  });
}

function revisionCases(make: MakeStore): void {
  it("reads an empty ledger at revision 0 before the first write", () => {
    expect(make().read()).toEqual({ ledger: { version: 1, claims: [] }, revision: 0 });
  });

  it("bumps the revision on each write", () => {
    const store = make();

    expect(store.write(ledgerOf(queued("TX-1")), 0)).toEqual({ revision: 1 });
    expect(store.write(ledgerOf(queued("TX-1"), queued("TX-2")), 1)).toEqual({ revision: 2 });
    expect(store.read().ledger.claims.map((c) => c.taskId)).toEqual(["TX-1", "TX-2"]);
  });

  it("hands out copies, so editing a read ledger changes nothing stored", () => {
    const store = make();
    store.write(ledgerOf(queued("TX-1")));

    store.read().ledger.claims.push(queued("TX-2"));

    expect(store.read().ledger.claims).toHaveLength(1);
  });
}

function refusalCases(make: MakeStore): void {
  it("refuses a stale expectedRevision and keeps the stored ledger", () => {
    const store = make();
    store.write(ledgerOf(queued("TX-1")));
    const before = store.read();

    expect(() => store.write(ledgerOf(), 0)).toThrow(StaleRevisionError);
    expect(store.read()).toEqual(before);
  });

  it("refuses a stored claim moving queued to shepherding and keeps the stored ledger", () => {
    const store = make();
    store.write(ledgerOf(queued("TX-1")));
    const before = store.read();
    const write = () => store.write(ledgerOf({ ...queued("TX-1"), phase: "shepherding" }));

    expect(write).toThrow(IllegalPhaseEdgeError);
    expect(write).toThrow(/TX-1# may not move from queued to shepherding/);
    expect(store.read()).toEqual(before);
  });

  it("refuses a ledger the schema refuses", () => {
    const bad: Ledger = JSON.parse('{ "version": 1, "claims": [{ "taskId": "TX-1" }] }');

    expect(() => make().write(bad)).toThrow(LedgerMalformedError);
  });
}

function normalizingCases(make: MakeStore): void {
  it("round-trips the fixture through import, read and export byte-equal", () => {
    const store = make();

    importLedgerJson(store, FIXTURE);

    expect(exportLedgerJson(store.read().ledger)).toBe(FIXTURE);
  });

  it("drops keys the schema does not name and trims contract scopes, keeping key order", () => {
    const store = make();
    const claim = { ...queued("TX-1"), contracts: [{ scope: " api ", op: "add" }], extra: 1 };
    const raw: Ledger = JSON.parse(JSON.stringify({ claims: [claim], stray: true, version: 1 }));

    store.write(raw);

    const { ledger } = store.read();
    expect(Object.keys(ledger)).toEqual(["claims", "version"]);
    expect(ledger.claims[0]).not.toHaveProperty("extra");
    expect(ledger.claims[0]?.contracts).toEqual([{ scope: "api", op: "add" }]);
  });
}
