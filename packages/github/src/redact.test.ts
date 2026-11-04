import { countCalls } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { redactStreams } from "./redact.js";

describe("redactStreams secret list", () => {
  it("redacts a secret that is a substring of another", () => {
    const [out] = redactStreams("a secret-long b", "", ["secret", "secret-long"]);

    expect(out).not.toContain("secret");
  });

  it("redacts a secret cut at the seam", () => {
    const [out, err] = redactStreams("x sec", "ret y", ["secret"]);

    expect(out + err).not.toMatch(/sec|ret/);
  });

  it("names the whitespace-cut secret as a limit by showing both halves", () => {
    const [out, err] = redactStreams("my sec \n", "ret", ["sec ret"]);

    expect([out, err]).toEqual(["my sec \n", "ret"]);
  });

  it("scans for 100 copies of a secret no more than for one", () => {
    const secret = "s3cr3t-value";
    const text = `${secret} `.repeat(Math.floor(1_000_000 / (secret.length + 1)));
    const many = Array.from({ length: 100 }, () => secret);
    // Each exact scan calls indexOf once per copy of the secret in the text, so a repeated secret would multiply them.
    const searches = (secrets: string[], cap?: number) => countCalls([[String.prototype, "indexOf"]], () => redactStreams(text, "", secrets), cap);
    const single = searches([secret]);

    expect(single).toBeGreaterThan(0);
    expect(searches(many, 2 * single)).toBe(single);
  });
});
