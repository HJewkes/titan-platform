import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json.js";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("canonicalJson", () => {
  it("emits sorted keys with no whitespace and drops undefined members", () => {
    expect(canonicalJson({ b: [2, { d: 1, c: undefined }], a: "x" })).toBe('{"a":"x","b":[2,{"d":1}]}');
  });

  it("keeps array order and null-prototype objects", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
    expect(canonicalJson(Object.assign(Object.create(null), { z: 1, a: null }))).toBe('{"a":null,"z":1}');
  });

  it("refuses values that do not survive a JSON round trip", () => {
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(/JSON/);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/JSON/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/JSON/);
  });

  it("pins the digests earlier releases produced for fixed inputs", () => {
    const sample = { schema: "unit/1", steps: [{ id: "a", n: 1.5 }, { id: "b", skip: undefined }], flag: true, none: null, text: "café \"q\"" };
    const text = canonicalJson(sample);

    expect(text).toBe('{"flag":true,"none":null,"schema":"unit/1","steps":[{"id":"a","n":1.5},{"id":"b"}],"text":"café \\"q\\""}');
    expect(sha256(text)).toBe("60df37abe3755dba0d26da12d2630cc9e2bb9efb05ee0366c16a37d9645f7212");
    expect(sha256(canonicalJson({ until: "2026-01-01", prs: [3, 1], repos: ["x"] }))).toBe("d1a9cb895380b2a9d9ed96b8f01ac7f096c0c9b99bfc273b1ad20abcf15ce0ce");
  });
});
