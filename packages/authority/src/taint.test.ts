import { describe, expect, it } from "vitest";
import { TAINT_REF_MAX_LENGTH, taintSourceSchema } from "./taint.js";
import { TAINT_KINDS } from "./vocabulary.js";

const source = { kind: "web-fetch", ref: "example.com", at: "2026-01-01T00:00:00.000Z" };

describe("taintSourceSchema", () => {
  it.each(TAINT_KINDS)("accepts a %s source", (kind) => {
    expect(taintSourceSchema.safeParse({ ...source, kind }).success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    expect(taintSourceSchema.safeParse({ ...source, kind: "local-read" }).success).toBe(false);
  });

  it("accepts a ref of exactly the maximum length", () => {
    expect(taintSourceSchema.safeParse({ ...source, ref: "r".repeat(TAINT_REF_MAX_LENGTH) }).success).toBe(true);
  });

  it("rejects a ref over 200 characters", () => {
    expect(taintSourceSchema.safeParse({ ...source, ref: "r".repeat(201) }).success).toBe(false);
  });

  it("rejects an empty ref", () => {
    expect(taintSourceSchema.safeParse({ ...source, ref: "" }).success).toBe(false);
  });

  it("rejects an at that is not an ISO timestamp", () => {
    expect(taintSourceSchema.safeParse({ ...source, at: "yesterday" }).success).toBe(false);
  });

  it("rejects a source carrying any field beyond kind, ref and at", () => {
    expect(taintSourceSchema.safeParse({ ...source, content: "fetched page text" }).success).toBe(false);
  });
});
