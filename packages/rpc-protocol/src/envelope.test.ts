import { describe, expect, it } from "vitest";
import { EXIT, errorEnvelope, successEnvelope } from "./envelope.js";

describe("envelopes on the wire", () => {
  it("omits the warnings key when there are none, so the JSON stays minimal", () => {
    expect(JSON.stringify(successEnvelope({ n: 1 }, []))).toBe('{"ok":true,"data":{"n":1}}');
    expect(JSON.stringify(successEnvelope({ n: 1 }))).toBe('{"ok":true,"data":{"n":1}}');
  });

  it("carries warnings after the data when present", () => {
    expect(JSON.stringify(successEnvelope("x", ["slow"]))).toBe('{"ok":true,"data":"x","warnings":["slow"]}');
  });

  it("serializes an error with its message before its code", () => {
    expect(JSON.stringify(errorEnvelope("nope", EXIT.USAGE))).toBe('{"ok":false,"error":"nope","code":64}');
  });

  it("keeps the sysexits numbers that CLIs and clients already branch on", () => {
    expect(EXIT).toEqual({ OK: 0, GENERIC: 1, USAGE: 64, DATAERR: 65, NOINPUT: 66, UNAVAILABLE: 69, SOFTWARE: 70, CONFIG: 78 });
  });
});
