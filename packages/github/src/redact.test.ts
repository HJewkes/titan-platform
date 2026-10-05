import { describe, expect, it } from "vitest";
import { redactStreams } from "./redact.js";

const timed = (run: () => void): number => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

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

  it("costs no more with 100 copies of a secret than with one", () => {
    const secret = "s3cr3t-value";
    const text = `${secret} `.repeat(Math.floor(1_000_000 / (secret.length + 1)));
    const one = [secret];
    const many = Array.from({ length: 100 }, () => secret);
    redactStreams(text, "", one);

    const single = Math.max(timed(() => redactStreams(text, "", one)), 1);
    const duplicated = timed(() => redactStreams(text, "", many));

    // Loose bound: undeduplicated this ran about 25x the single-secret time.
    expect(duplicated).toBeLessThan(single * 4 + 200);
  });
});
