import { describe, expect, it } from "vitest";
import { errorCode, isObjectLike } from "@titan-design/rpc-protocol/narrow";
import { errorMessage, errorStatus, isOneOf, readPath } from "./narrow.js";

describe("isObjectLike", () => {
  it("accepts objects and arrays", () => {
    expect(isObjectLike({})).toBe(true);
    expect(isObjectLike([])).toBe(true);
  });

  it.each([[null], [undefined], ["text"], [1]])("refuses %s", (value) => {
    expect(isObjectLike(value)).toBe(false);
  });
});

describe("readPath", () => {
  it("walks nested objects", () => {
    expect(readPath({ a: { b: 1 } }, "a", "b")).toBe(1);
  });

  it("answers undefined when a step is missing or not an object", () => {
    expect(readPath({ a: "text" }, "a", "b")).toBeUndefined();
    expect(readPath(null, "a")).toBeUndefined();
  });
});

describe("errorMessage", () => {
  it("reads an Error and a wire error shaped like one", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage({ message: "wire" })).toBe("wire");
  });

  it("prints anything else thrown", () => {
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage(null)).toBe("null");
  });
});

describe("errorCode", () => {
  it("reads a string code only", () => {
    expect(errorCode({ code: "ENOENT" })).toBe("ENOENT");
    expect(errorCode({ code: 1 })).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
  });
});

describe("errorStatus", () => {
  it("reads the status of whatever was thrown", () => {
    expect(errorStatus({ status: 404 })).toBe(404);
    expect(errorStatus(null)).toBeUndefined();
  });
});

describe("isOneOf", () => {
  it("tells listed values from the rest", () => {
    expect(isOneOf(["open", "closed"], "open")).toBe(true);
    expect(isOneOf(["open", "closed"], "merged")).toBe(false);
  });
});
