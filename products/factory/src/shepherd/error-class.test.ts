import { describe, expect, it } from "vitest";
import { consoleTextOf, errorClass, failureOf } from "./error-class.js";

const LEAKY = "fetch https://db.example.invalid/x with tok_FAKE0000SECRET failed";

class StorageFault extends Error {
  override readonly name = "StorageFault";
}

describe("errorClass", () => {
  it("names the class of an error and none of its message", () => {
    expect(errorClass(new StorageFault(LEAKY))).toBe("StorageFault");
    expect(errorClass(new Error(LEAKY))).toBe("Error");
  });

  it("falls back to Error when the name is not a plain identifier", () => {
    const error = new Error("x");
    error.name = LEAKY;
    expect(errorClass(error)).toBe("Error");
  });

  it.each([
    ["ghp_", "ghp_FAKE0000NOTAREALTOKEN0000"],
    ["ghs_", "ghs_FAKE0000NOTAREALTOKEN0000"],
    ["gho_", "gho_FAKE0000NOTAREALTOKEN0000"],
    ["github_pat_", "github_pat_FAKE0000NOTAREAL_0000"],
    ["a JWT head", "eyJhbGciOiJub25lIn0"],
    ["32 hex characters", "Fault0123456789abcdef0123456789abcdef"],
  ])("falls back to Error for an identifier-shaped name that looks like a credential (%s)", (_shape, name) => {
    const error = new Error("x");
    error.name = name;
    expect(errorClass(error)).toBe("Error");
  });

  it("keeps a class name with a short hex run", () => {
    const error = new Error("x");
    error.name = "Fault0123456789abcdef";
    expect(errorClass(error)).toBe("Fault0123456789abcdef");
  });

  it("falls back to Error when reading the name throws", () => {
    const error = new Error("x");
    Object.defineProperty(error, "name", { get: () => { throw new Error(LEAKY); } });
    expect(errorClass(error)).toBe("Error");
  });

  it("says non-Error for a thrown string", () => {
    expect(errorClass(LEAKY)).toBe("non-Error");
  });

  it("falls back to Error when the instanceof check itself throws", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(errorClass(proxy)).toBe("Error");
  });
});

describe("failureOf", () => {
  it("gives the HTTP status when the error carries a numeric one", () => {
    expect(failureOf(Object.assign(new Error(LEAKY), { status: 502 }))).toBe("HTTP 502");
  });

  it.each([1, 99, 600, 42_000])("gives the class, not an HTTP status, for the numeric status %i outside 100-599", (status) => {
    expect(failureOf(Object.assign(new StorageFault(LEAKY), { status }))).toBe("StorageFault");
  });

  it("gives the HTTP status at both ends of the 100-599 range", () => {
    expect(failureOf(Object.assign(new Error(LEAKY), { status: 100 }))).toBe("HTTP 100");
    expect(failureOf(Object.assign(new Error(LEAKY), { status: 599 }))).toBe("HTTP 599");
  });

  it("gives the class when the status is absent or not a number", () => {
    expect(failureOf(Object.assign(new StorageFault(LEAKY), { status: LEAKY }))).toBe("StorageFault");
    expect(failureOf(undefined)).toBe("non-Error");
  });
});

describe("consoleTextOf", () => {
  it("gives the message of an error and the text of a thrown value", () => {
    expect(consoleTextOf(new StorageFault("disk full"))).toBe("disk full");
    expect(consoleTextOf("plain")).toBe("plain");
  });

  it("names the class instead of throwing when the message getter throws", () => {
    const error = new StorageFault("x");
    Object.defineProperty(error, "message", { get: () => { throw new Error(LEAKY); } });
    expect(consoleTextOf(error)).toBe("(unreadable StorageFault)");
  });
});
