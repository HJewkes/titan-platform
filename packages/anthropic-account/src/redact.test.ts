import { describe, expect, it } from "vitest";
import { CANARY, FAKE_ACCESS_TOKEN, FAKE_JWT, FAKE_OPAQUE, FAKE_REFRESH_TOKEN } from "./fixtures/fake-tokens.js";
import { REDACTED, redactSecrets } from "./redact.js";

describe("redactSecrets on a string", () => {
  it.each([
    ["an OAuth access token", `token ${FAKE_ACCESS_TOKEN} rejected`],
    ["an OAuth refresh token", `refresh with ${FAKE_REFRESH_TOKEN}`],
    ["a JWT", `jwt=${FAKE_JWT}`],
    ["a bearer header", `Authorization: Bearer ${FAKE_ACCESS_TOKEN}`],
    ["a short bearer value", `authorization: bearer ${CANARY}x`],
    ["a JSON access token field with a short value", `{"accessToken":"${CANARY}1"}`],
    ["a JSON refresh token field with a short value", `{"refresh_token": "${CANARY}2"}`],
    ["an api key header", `x-api-key=${CANARY}3`],
    ["a long base64url run", `cookie ${FAKE_OPAQUE} set`],
  ])("removes %s", (_case, text) => {
    const redacted = redactSecrets(text);

    expect(redacted).not.toContain(CANARY);
    expect(redacted).toContain(REDACTED);
  });

  it("keeps the words around a secret", () => {
    expect(redactSecrets(`GET /api/oauth/usage failed: Bearer ${FAKE_ACCESS_TOKEN} (401)`)).toBe(
      `GET /api/oauth/usage failed: Bearer ${REDACTED} (401)`,
    );
  });

  it("leaves text with no secret unchanged", () => {
    const text = "usage poll for agents: HTTP 503, retry in 150 s";

    expect(redactSecrets(text)).toBe(text);
  });

  it("is stable when applied twice", () => {
    const once = redactSecrets(`Bearer ${FAKE_ACCESS_TOKEN} and ${FAKE_JWT}`);

    expect(redactSecrets(once)).toBe(once);
  });
});

describe("redactSecrets on an Error", () => {
  const original = new TypeError(`fetch failed for Bearer ${FAKE_ACCESS_TOKEN}`, {
    cause: new Error(FAKE_REFRESH_TOKEN),
  });

  it("returns an Error whose message, name and stack hold no secret", () => {
    const redacted = redactSecrets(original);

    expect(redacted).toBeInstanceOf(Error);
    expect(redacted.message).toBe(`fetch failed for Bearer ${REDACTED}`);
    expect(redacted.name).toBe("TypeError");
    expect(redacted.stack ?? "").not.toContain(CANARY);
  });

  it("drops the cause", () => {
    expect(redactSecrets(original).cause).toBeUndefined();
  });

  it("serializes with no secret", () => {
    const redacted = redactSecrets(original);

    expect(JSON.stringify(redacted, Object.getOwnPropertyNames(redacted))).not.toContain(CANARY);
    expect(String(redacted)).not.toContain(CANARY);
  });

  it("leaves the original untouched", () => {
    redactSecrets(original);

    expect(original.message).toContain(CANARY);
  });
});
