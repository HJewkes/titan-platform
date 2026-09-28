import { describe, expect, it } from "vitest";
import { MAX_STORED_ERROR_CHARS, REDACTED, redactForEvidence } from "./redact.js";

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

  it("caps stored text at a fixed length", () => {
    const stored = redactForEvidence("x".repeat(5_000));

    expect(stored.length).toBeLessThan(MAX_STORED_ERROR_CHARS + 20);
    expect(stored).toMatch(/\[truncated\]$/);
  });
});
