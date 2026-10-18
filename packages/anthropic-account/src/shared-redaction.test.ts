import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact.js";

const fakeKeys = ["sk-fixture", "sk-proj-fixture", "sk-svcacct-fixture", "sk-ant-fixture"];

describe("shared provider redaction conformance", () => {
  it.each(fakeKeys)("removes the complete synthetic key %s", key => {
    expect(redactSecrets(`before ${key} after`)).toBe("before [REDACTED] after");
  });
  it.each(["sk-proj-fixture", "sk-ant-fixture"])("redacts a whole JWT containing a synthetic key substring %s", key => {
    expect(redactSecrets(`eyJfixture-${key}.payload.signature`)).toBe("[REDACTED]");
  });
  it("redacts a whole JWT whose valid synthetic signed payload contains a key substring", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ fixture: " \uFB13\u1000" })).toString("base64url");
    const body = `${header}.${payload}`;
    const signature = createHmac("sha256", "public-synthetic-fixture-key").update(body).digest("base64url");
    expect(payload).toContain("-sk-");
    expect(redactSecrets(`${body}.${signature}`)).toBe("[REDACTED]");
  });
  it.each(["message", "name", "stack"])("refuses hostile %s getters without leaking their exception", field => {
    const original = new Error("synthetic");
    Object.defineProperty(original, field, { get() { throw new Error("synthetic private detail"); } });
    const result = redactSecrets(original);
    expect(result === original).toBe(false);
    expect(result.message).toBe("[REDACTED]");
    expect(result.cause).toBeUndefined();
    expect(String(result)).not.toContain("private detail");
  });
  it("copies only redacted Error fields and leaves the original unchanged", () => {
    const original = new Error("sk-proj-fixture", { cause: new Error("synthetic private cause") });
    original.name = "sk-svcacct-fixture";
    original.stack = "stack sk-proj-fixture Bearer short-fixture";
    Object.assign(original, { extra: "synthetic private extra" });
    Object.freeze(original);
    const result = redactSecrets(original);
    expect(result.message).toBe("[REDACTED]");
    expect(result.name).toBe("[REDACTED]");
    expect(result.stack).toBe("stack [REDACTED] Bearer [REDACTED]");
    expect(Object.getOwnPropertyNames(result).sort()).toEqual(["message", "name", "stack"]);
    expect(result.cause).toBeUndefined();
    expect(original.message).toBe("sk-proj-fixture");
  });
  it("preserves an explicitly empty stack without generating new diagnostic context", () => {
    const original = new Error("sk-proj-fixture");
    original.stack = "";
    expect(redactSecrets(original).stack).toBe("");
  });
  it("redacts credentials while retaining ordinary diagnostic text", () => {
    expect(redactSecrets("HTTP 503 Bearer short-fixture password=fixture")).toBe("HTTP 503 Bearer [REDACTED] password=[REDACTED]");
    const once = redactSecrets("sk-proj-fixture Bearer short-fixture");
    expect(redactSecrets(once)).toBe(once);
  });
});
