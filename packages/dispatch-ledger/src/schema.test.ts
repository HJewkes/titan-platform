import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaimSchema, LedgerSchema, PHASES } from "./schema.js";

const fixture = (): { claims: Record<string, unknown>[] } & Record<string, unknown> =>
  JSON.parse(fs.readFileSync(new URL("./fixtures/burndown-ledger.json", import.meta.url), "utf8"));

describe("LedgerSchema", () => {
  it("parses the synthetic ledger with a claim in every phase", () => {
    const result = LedgerSchema.safeParse(fixture());

    expect(result.success).toBe(true);
    expect(result.data?.claims.map((c) => c.phase)).toEqual([...PHASES]);
  });

  it("refuses a claim with an unknown phase", () => {
    const ledger = fixture();
    ledger.claims[0] = { ...ledger.claims[0], phase: "paused" };

    expect(LedgerSchema.safeParse(ledger).success).toBe(false);
  });

  it("refuses a stall code outside STALL_CODES", () => {
    const ledger = fixture();
    ledger.claims[4] = { ...ledger.claims[4], stallCode: "gave-up" };

    expect(LedgerSchema.safeParse(ledger).success).toBe(false);
  });

  it("refuses a ledger of another version", () => {
    expect(LedgerSchema.safeParse({ ...fixture(), version: 2 }).success).toBe(false);
  });

  it("strips nothing from the fixture, which carries every field agent-chat writes", () => {
    const raw = fixture();

    expect(LedgerSchema.parse(raw)).toEqual(raw);
  });

  it("accepts a claim parked on no-repo", () => {
    const parked = fixture().claims.find((c) => c.stallCode === "no-repo");

    expect(parked).toBeDefined();
    expect(ClaimSchema.safeParse(parked).success).toBe(true);
  });

  it("refuses a dailyRetire stamp that is not an ISO datetime", () => {
    const ledger = { ...fixture(), dailyRetire: { "seat-a": "yesterday" } };

    expect(LedgerSchema.safeParse(ledger).success).toBe(false);
  });

  it("refuses a reregistered count of zero", () => {
    const ledger = fixture();
    ledger.claims[7] = { ...ledger.claims[7], reregistered: { n: 0, at: "2026-01-03T10:00:00.000Z" } };

    expect(LedgerSchema.safeParse(ledger).success).toBe(false);
  });
});
