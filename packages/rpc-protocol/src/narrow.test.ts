import { describe, expect, it } from "vitest";
import { errorCode, isObjectLike, isRecord } from "./narrow.js";

describe("isRecord", () => {
  it("accepts plain objects, null-prototype objects and class instances", () => {
    const values = [{}, { a: 1 }, Object.create(null), new Date(0)];

    const results = values.map((value) => isRecord(value));

    expect(results).toEqual([true, true, true, true]);
  });

  it("refuses arrays, null and primitives", () => {
    const values = [[], [1], null, undefined, "text", 1, true];

    const results = values.map((value) => isRecord(value));

    expect(results.every((result) => !result)).toBe(true);
  });

  it("refuses a function", () => {
    const fn = (): void => undefined;

    expect(isRecord(fn)).toBe(false);
  });
});

describe("isObjectLike", () => {
  it("accepts arrays as well as objects", () => {
    const values = [[], [1], {}];

    const results = values.map((value) => isObjectLike(value));

    expect(results).toEqual([true, true, true]);
  });

  it("refuses null, functions and primitives", () => {
    const values = [null, undefined, "text", 0, (): void => undefined];

    const results = values.map((value) => isObjectLike(value));

    expect(results.every((result) => !result)).toBe(true);
  });
});

describe("errorCode", () => {
  it("reads the code of a Node system error", () => {
    const thrown = Object.assign(new Error("gone"), { code: "ENOENT" });

    expect(errorCode(thrown)).toBe("ENOENT");
  });

  it("reads the code of a plain object, such as a wire error or another realm's Error", () => {
    expect(errorCode({ code: "EEXIST" })).toBe("EEXIST");
  });

  it("returns undefined when the code is not a string", () => {
    expect(errorCode({ code: 404 })).toBeUndefined();
  });

  it("returns undefined for an Error with no code and for non-objects", () => {
    const values = [new Error("plain"), "ENOENT", null, undefined];

    const results = values.map((value) => errorCode(value));

    expect(results).toEqual([undefined, undefined, undefined, undefined]);
  });
});
