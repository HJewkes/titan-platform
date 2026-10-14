import { describe, expect, it } from "vitest";
import { MAX_STORED_ERROR_CHARS, REDACTED, redactCredentials, redactForEvidence } from "./redact.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig_-x";

describe("error text stored as evidence", () => {
  it.each(["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_11AB_"])("replaces a %s token with a marker", (prefix) => {
    const token = `${prefix}${"a1B2".repeat(9)}`;

    const stored = redactForEvidence(`gh: Bad credentials for ${token} (HTTP 401)`);

    expect(stored).toBe(`gh: Bad credentials for ${REDACTED} (HTTP 401)`);
  });

  it("replaces Authorization header values, with or without a scheme", () => {
    const stored = redactForEvidence("> Authorization: token abc123\n> authorization: Bearer xyz.789\n> Authorization:raw");

    expect(stored).toBe(`> Authorization: ${REDACTED}\n> authorization: ${REDACTED}\n> Authorization:${REDACTED}`);
  });

  it("keeps the Authorization rule ahead of the JWT rule for a bearer token", () => {
    expect(redactCredentials(`Authorization: Bearer ${JWT}`)).toBe(`Authorization: ${REDACTED}`);
  });

  it.each([
    ["an npm token", `npm ERR! token npm_${"a1B2".repeat(9)}`, `npm ERR! token ${REDACTED}`],
    ["an sk-proj key", `key sk-proj-${"aB3_-".repeat(8)} end`, `key ${REDACTED} end`],
    ["an sk-ant key", `key=sk-ant-api03-${"Zx9".repeat(10)}`, `key=${REDACTED}`],
    ["a three-segment JWT", `jwt ${JWT} ok`, `jwt ${REDACTED} ok`],
    ["ssh userinfo", "ssh://deploy:hunter2@host/repo", `ssh://${REDACTED}@host/repo`],
    ["postgres userinfo", "postgres://u:p%40ss@db:5432/x", `postgres://${REDACTED}@db:5432/x`],
    ["https userinfo", "fetch https://u:p@github.com failed", `fetch https://${REDACTED}@github.com failed`],
  ])("replaces %s", (_name, input, expected) => {
    expect(redactCredentials(input)).toBe(expected);
  });

  it.each([
    "npm_config_cache=/tmp",
    "task-sk-123",
    `task-sk-${"a".repeat(30)}`,
    "pkg.json.lock",
    "eyJ alone",
    "ssh://git@github.com:org/repo",
    "mailto:a@b.c",
  ])("leaves %s unchanged", (input) => {
    expect(redactCredentials(input)).toBe(input);
  });

  it("caps stored text at a fixed length", () => {
    const stored = redactForEvidence("x".repeat(5_000));

    expect(stored.length).toBeLessThan(MAX_STORED_ERROR_CHARS + 20);
    expect(stored).toMatch(/\[truncated\]$/);
  });
});
