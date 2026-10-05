import { expect } from "vitest";

/** An error message carrying a URL with a query token and a GitHub-token-shaped string, as a failing request might echo. */
export const LEAKY_MESSAGE = "GET https://api.leak.invalid/repos?access_token=s3cr3t-query failed for ghp_abcdefghijklmnopqrstuvwxyz0123456789";

/** Asserts that nothing from LEAKY_MESSAGE's URL or token reached the stored value. */
export function expectNoLeak(stored: unknown): void {
  const text = typeof stored === "string" ? stored : JSON.stringify(stored);
  expect(text).not.toContain("leak.invalid");
  expect(text).not.toContain("s3cr3t-query");
  expect(text).not.toContain("ghp_");
}
