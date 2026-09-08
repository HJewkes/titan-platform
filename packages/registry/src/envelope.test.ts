import { describe, expect, it } from "vitest";
import { EXIT, describeError, errorEnvelope, successEnvelope } from "./envelope.js";

describe("envelopes", () => {
  it("omits warnings when there are none", () => {
    expect(successEnvelope({ n: 1 })).toEqual({ ok: true, data: { n: 1 } });
    expect(successEnvelope({ n: 1 }, [])).toEqual({ ok: true, data: { n: 1 } });
  });

  it("carries warnings when present", () => {
    expect(successEnvelope("x", ["careful"])).toEqual({ ok: true, data: "x", warnings: ["careful"] });
  });

  it("builds an error envelope with a code", () => {
    expect(errorEnvelope("boom", EXIT.NOINPUT)).toEqual({ ok: false, error: "boom", code: 66 });
  });
});

describe("describeError", () => {
  it("reads a numeric code off an Error subclass", () => {
    class NotFound extends Error {
      readonly code = EXIT.NOINPUT;
    }
    expect(describeError(new NotFound("gone"))).toEqual({ message: "gone", code: 66 });
  });

  it("falls back to GENERIC for errors without a numeric code", () => {
    expect(describeError(new Error("plain"))).toEqual({ message: "plain", code: 1 });
    const withStringCode = Object.assign(new Error("enoent"), { code: "ENOENT" });
    expect(describeError(withStringCode).code).toBe(EXIT.GENERIC);
  });

  it("stringifies non-Error throwables", () => {
    expect(describeError("raw")).toEqual({ message: "raw", code: 1 });
  });
});
