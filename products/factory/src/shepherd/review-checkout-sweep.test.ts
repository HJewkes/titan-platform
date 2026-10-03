import { mkdirSync, mkdtempSync, rmSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REVIEW_CHECKOUT_MAX_AGE_MS, sweepReviewCheckouts } from "./review-checkout-sweep.js";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const HOUR = 3_600_000;

describe("sweepReviewCheckouts", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "review-sweep-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function dir(name: string, ageMs: number): string {
    const path = join(root, name);
    mkdirSync(path);
    const when = new Date(NOW - ageMs);
    utimesSync(path, when, when);
    return path;
  }

  it("removes a review checkout older than a day", () => {
    const old = dir("review-7-abcdef123456", REVIEW_CHECKOUT_MAX_AGE_MS + HOUR);

    const removed = sweepReviewCheckouts({ root, now: () => NOW });

    expect(removed).toEqual([old]);
    expect(existsSync(old)).toBe(false);
  });

  it("keeps a review checkout younger than a day", () => {
    const fresh = dir("review-8-abcdef123456", HOUR);

    const removed = sweepReviewCheckouts({ root, now: () => NOW });

    expect(removed).toEqual([]);
    expect(existsSync(fresh)).toBe(true);
  });

  it("keeps an old directory outside the review- prefix", () => {
    const other = dir("not-a-review", REVIEW_CHECKOUT_MAX_AGE_MS * 5);

    const removed = sweepReviewCheckouts({ root, now: () => NOW });

    expect(removed).toEqual([]);
    expect(existsSync(other)).toBe(true);
  });
});
