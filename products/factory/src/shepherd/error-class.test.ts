import { describe, expect, it } from "vitest";
import { errorClass, failureOf } from "./error-class.js";

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

  it("gives the class when the status is absent or not a number", () => {
    expect(failureOf(Object.assign(new StorageFault(LEAKY), { status: LEAKY }))).toBe("StorageFault");
    expect(failureOf(undefined)).toBe("non-Error");
  });
});
