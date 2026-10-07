import { describe, expect, it } from "vitest";
import { item } from "./test-fixtures.js";
import { ownerItemSchema, sourceRefSchema } from "./schema.js";

describe("ownerItemSchema", () => {
  it("accepts a minimal open item", () => {
    expect(ownerItemSchema.safeParse(item({ id: "chat:m-1" })).success).toBe(true);
  });

  it.each([
    ["no source", { sources: [] }],
    ["a summary over 280 chars", { summary: "x".repeat(281) }],
    ["a two-line summary", { summary: "line one\nline two" }],
    ["a single option", { options: [{ id: "a", label: "A" }] }],
    ["an open time with no zone", { openedAt: "2026-01-01T00:00:00" }],
    ["a confidence above 1", { recommended: { optionId: "a", by: "decider", confidence: 1.5 } }],
  ])("rejects %s", (_label, overrides) => {
    expect(ownerItemSchema.safeParse({ ...item({ id: "chat:m-1" }), ...overrides }).success).toBe(false);
  });
});

describe("sourceRefSchema", () => {
  it("rejects a system outside the known stores of record", () => {
    expect(sourceRefSchema.safeParse({ system: "email", ref: "m-1" }).success).toBe(false);
  });
});
