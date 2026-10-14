import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { LedgerSchema, PHASES } from "./schema.js";

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
});
