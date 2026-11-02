import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { FactEntry } from "../registry/entry.js";
import { outputDigest, projectionDigest } from "./projection.js";

const entry: FactEntry = {
  name: "synthetic",
  op: "dispatch",
  kind: "software",
  effect: { class: "read" },
  callSites: [],
  version: { bump: 0 },
  fact: "synthetic.fact",
  input: z.unknown(),
  output: z.unknown(),
  materialInputs: [],
  projection: ["verdict", "detail.count"],
  idempotencyKey: () => "k",
  body: "x.ts",
};

describe("projection digests", () => {
  it("two outputs that differ only outside the projection have one projection digest and two output digests", () => {
    const a = { verdict: "ok", detail: { count: 2 }, note: "first" };
    const b = { verdict: "ok", detail: { count: 2 }, note: "second" };
    expect(projectionDigest(entry, a)).toBe(projectionDigest(entry, b));
    expect(outputDigest(a)).not.toBe(outputDigest(b));
    expect(projectionDigest(entry, a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("a missing projected field and a null one give different digests", () => {
    expect(projectionDigest(entry, { verdict: "ok", detail: { count: null } })).not.toBe(projectionDigest(entry, { verdict: "ok", detail: {} }));
  });
});
