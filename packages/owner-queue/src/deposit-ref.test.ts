import { describe, expect, it } from "vitest";
import { resolveDepositRef } from "./deposit-ref.js";

const A = { id: "deposit:18d6520b0000000000000000000000aa" };
const B = { id: "deposit:18d6520b0000000000000000000000bb" };
const C = { id: "deposit:c0ffee00111111111111111111111111" };
const ITEMS = [A, B, C];

describe("resolveDepositRef", () => {
  it("finds a deposit by its exact full id", () => {
    expect(resolveDepositRef(ITEMS, A.id)).toEqual({ kind: "found", item: A });
  });

  it("finds the one deposit a deposit:-prefixed short prefix starts", () => {
    expect(resolveDepositRef(ITEMS, "deposit:c0ffee00")).toEqual({ kind: "found", item: C });
  });

  it("finds the one deposit a bare 8-hex prefix starts, in either case", () => {
    expect(resolveDepositRef(ITEMS, "c0ffee00")).toEqual({ kind: "found", item: C });
    expect(resolveDepositRef(ITEMS, "C0FFEE00")).toEqual({ kind: "found", item: C });
  });

  it("lists every full id an ambiguous prefix matches", () => {
    expect(resolveDepositRef(ITEMS, "18d6520b")).toEqual({ kind: "ambiguous", ids: [A.id, B.id] });
  });

  it("reports a prefix under 8 hex digits, a non-hex ref, or no match as unknown", () => {
    for (const ref of ["c0ffee0", "deposit:c0ff", "not-hex-at-all", "deadbeef", "deposit:"]) {
      expect(resolveDepositRef(ITEMS, ref)).toEqual({ kind: "unknown" });
    }
  });

  it("marks an id of another item kind as not a deposit, even when its tail is hex", () => {
    for (const ref of ["gate:g-1", "round:kiln-r1/q1", "gate:c0ffee00"]) {
      expect(resolveDepositRef(ITEMS, ref)).toEqual({ kind: "not-deposit" });
    }
  });
});
