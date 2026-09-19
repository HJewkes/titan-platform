import { describe, expect, it } from "vitest";
import { canonicalArgs, snapshotKey, wireArgs } from "./canonical-key.js";

describe("snapshotKey", () => {
  it.each([
    ["key order at the top level", { a: 1, b: 2 }, { b: 2, a: 1 }],
    ["key order in nested objects", { f: { x: 1, y: [{ p: 1, q: 2 }] } }, { f: { y: [{ q: 2, p: 1 }], x: 1 } }],
    ["an undefined property and a missing one", { a: 1, b: undefined }, { a: 1 }],
    ["an undefined nested property and a missing one", { f: { a: undefined, b: 2 } }, { f: { b: 2 } }],
    ["no args and an empty object", undefined, {}],
    ["null args and an empty object", null, {}],
    ["integer-like keys in any order", { "10": "x", "2": "y", b: "z" }, { b: "z", "2": "y", "10": "x" }],
    ["a Date and its JSON string", { at: new Date("2026-09-18T00:00:00Z") }, { at: "2026-09-18T00:00:00.000Z" }],
  ])("treats %s as the same call", (_label, left, right) => {
    expect(snapshotKey("task.list", left)).toBe(snapshotKey("task.list", right));
  });

  it.each([
    ["array order", { tags: ["a", "b"] }, { tags: ["b", "a"] }],
    ["null and a missing property", { a: null }, {}],
    ["a number and its string", { n: 1 }, { n: "1" }],
    ["an empty array and an empty object", { v: [] }, { v: {} }],
    ["an undefined array element and a shorter array", { v: [1, undefined] }, { v: [1] }],
  ])("tells %s apart", (_label, left, right) => {
    expect(snapshotKey("task.list", left)).not.toBe(snapshotKey("task.list", right));
  });

  it("separates commands whose names and args could run together", () => {
    expect(snapshotKey("a", { b: 1 })).not.toBe(snapshotKey("a{", { b: 1 }));
    expect(snapshotKey("task.list", {})).toBe('["task.list",{}]');
  });

  it("keeps a __proto__ key as data", () => {
    const args = JSON.parse('{"__proto__":{"x":1},"a":2}') as unknown;
    expect(canonicalArgs(args)).toBe('{"__proto__":{"x":1},"a":2}');
  });

  it("prints the same text however often it is computed", () => {
    const args = { z: [3, { b: 1, a: 2 }], a: { d: 4, c: 3 } };
    const keys = new Set(Array.from({ length: 5 }, () => snapshotKey("x", structuredClone(args))));
    expect([...keys]).toEqual(['["x",{"a":{"c":3,"d":4},"z":[3,{"a":2,"b":1}]}]']);
  });
});

describe("wireArgs", () => {
  it("gives what a daemon would parse from the request body", () => {
    expect(wireArgs({ a: undefined, b: [undefined], c: Number.NaN })).toEqual({ b: [null], c: null });
    expect(wireArgs(undefined)).toEqual({});
  });
});
