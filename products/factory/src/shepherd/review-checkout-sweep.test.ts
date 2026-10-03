import { mkdirSync, mkdtempSync, rmSync, utimesSync, existsSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
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

  it("keeps sweeping past a dangling review- symlink", () => {
    symlinkSync(join(root, "missing-target"), join(root, "review-1-aaaaaaaaaaaa"));
    const old = dir("review-2-bbbbbbbbbbbb", REVIEW_CHECKOUT_MAX_AGE_MS + HOUR);
    const errors: string[] = [];

    const removed = sweepReviewCheckouts({ root, now: () => NOW, onError: (p) => errors.push(p) });

    expect(removed).toEqual([old]);
    expect(errors).toEqual([]);
    expect(lstatSync(join(root, "review-1-aaaaaaaaaaaa")).isSymbolicLink()).toBe(true);
  });

  it("skips an entry that vanishes between list and stat", () => {
    const old = dir("review-3-cccccccccccc", REVIEW_CHECKOUT_MAX_AGE_MS + HOUR);
    const errors: string[] = [];

    const removed = sweepReviewCheckouts({
      root,
      now: () => NOW,
      list: () => ["review-gone-dddddddddddd", "review-3-cccccccccccc"],
      onError: (p) => errors.push(p),
    });

    expect(removed).toEqual([old]);
    expect(errors).toEqual([join(root, "review-gone-dddddddddddd")]);
  });

  it("keeps a plain file named review-x", () => {
    const file = join(root, "review-x");
    writeFileSync(file, "x");
    const when = new Date(NOW - REVIEW_CHECKOUT_MAX_AGE_MS * 5);
    utimesSync(file, when, when);

    const removed = sweepReviewCheckouts({ root, now: () => NOW });

    expect(removed).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
});
