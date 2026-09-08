import { describe, expect, it } from "vitest";
import { isRef, parseRef, ref, refKind } from "./ref.js";

describe("ref grammar", () => {
  it("mints and parses kind:id, keeping colons and hashes inside the id", () => {
    expect(ref("session", "abc")).toBe("session:abc");
    expect(parseRef("codewatch:repo#src/a.ts::Foo")).toEqual({ kind: "codewatch", id: "repo#src/a.ts::Foo" });
    expect(parseRef("file:repo/path/with:colon")).toEqual({ kind: "file", id: "repo/path/with:colon" });
  });

  it("rejects bad kinds, empty ids, and malformed strings", () => {
    expect(() => ref("Session", "x")).toThrow(/invalid ref kind/);
    expect(() => ref("session", "")).toThrow(/must not be empty/);
    expect(() => parseRef("noseparator")).toThrow(/invalid ref/);
    expect(() => parseRef("session:")).toThrow(/invalid ref/);
    expect(() => parseRef(":id")).toThrow(/invalid ref/);
    expect(isRef("task:TP-4")).toBe(true);
    expect(isRef("TASK:TP-4")).toBe(false);
    expect(isRef(42)).toBe(false);
  });

  it("builds typed minters per kind", () => {
    const task = refKind("task");
    expect(task("TP-4")).toBe("task:TP-4");
    expect(() => refKind("Bad Kind")).toThrow(/invalid ref kind/);
  });
});
