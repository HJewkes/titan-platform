import { mkdirSync, mkdtempSync, rmSync, utimesSync, existsSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewCheckoutName } from "@titan-design/review-panel";
import { REVIEW_CHECKOUT_MAX_AGE_MS, REVIEW_CHECKOUT_NAME, sweepReviewCheckouts } from "./review-checkout-sweep.js";

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

  it("removes a review checkout older than a day", async () => {
    const old = dir("review-7-abcdef123456", REVIEW_CHECKOUT_MAX_AGE_MS + HOUR);

    const removed = await sweepReviewCheckouts({ root, now: () => NOW });

    expect(removed).toEqual([old]);
    expect(existsSync(old)).toBe(false);
  });

  it("keeps a review checkout younger than a day", async () => {
    const fresh = dir("review-8-abcdef123456", HOUR);

    const removed = await sweepReviewCheckouts({ root, now: () => NOW });

    expect(removed).toEqual([]);
    expect(existsSync(fresh)).toBe(true);
  });

  it("keeps an old directory outside the review- prefix", async () => {
    const other = dir("not-a-review", REVIEW_CHECKOUT_MAX_AGE_MS * 5);

    const removed = await sweepReviewCheckouts({ root, now: () => NOW });

    expect(removed).toEqual([]);
    expect(existsSync(other)).toBe(true);
  });

  it("keeps sweeping past a dangling review- symlink", async () => {
    symlinkSync(join(root, "missing-target"), join(root, "review-1-aaaaaaaaaaaa"));
    const old = dir("review-2-bbbbbbbbbbbb", REVIEW_CHECKOUT_MAX_AGE_MS + HOUR);
    const errors: string[] = [];

    const removed = await sweepReviewCheckouts({ root, now: () => NOW, onError: (p) => errors.push(p) });

    expect(removed).toEqual([old]);
    expect(errors).toEqual([]);
    expect(lstatSync(join(root, "review-1-aaaaaaaaaaaa")).isSymbolicLink()).toBe(true);
  });

  it("skips an entry that vanishes between list and stat", async () => {
    const old = dir("review-3-cccccccccccc", REVIEW_CHECKOUT_MAX_AGE_MS + HOUR);
    const errors: string[] = [];

    const removed = await sweepReviewCheckouts({
      root,
      now: () => NOW,
      list: async () => ["review-9-dddddddddddd", "review-3-cccccccccccc"],
      onError: (p) => errors.push(p),
    });

    expect(removed).toEqual([old]);
    expect(errors).toEqual([join(root, "review-9-dddddddddddd")]);
  });

  it("keeps foreign and malformed review- names however old", async () => {
    const names = ["review-notes", "review-12-ABCDEF123456", "review-0-abcdef123456", "review-12-abcdef12345"];
    const paths = names.map((name) => dir(name, REVIEW_CHECKOUT_MAX_AGE_MS * 5));
    const target = dir("real-target", REVIEW_CHECKOUT_MAX_AGE_MS * 5);
    const link = join(root, "review-13-aaaaaaaaaaaa");
    symlinkSync(target, link);

    const removed = await sweepReviewCheckouts({ root, now: () => NOW });

    expect(removed).toEqual([]);
    for (const path of [...paths, target, link]) expect(existsSync(path)).toBe(true);
  });

  it("removes review-12-0123456789ab and reports a failed removal while carrying on", async () => {
    const bad = dir("review-12-0123456789ab", REVIEW_CHECKOUT_MAX_AGE_MS + HOUR);
    const good = dir("review-14-0123456789ac", REVIEW_CHECKOUT_MAX_AGE_MS + HOUR);
    const errors: Array<[string, unknown]> = [];
    const failure = new Error("EBUSY");

    const removed = await sweepReviewCheckouts({
      root,
      now: () => NOW,
      list: async () => ["review-12-0123456789ab", "review-14-0123456789ac"],
      remove: async (path) => {
        if (path === bad) throw failure;
        rmSync(path, { recursive: true, force: true });
      },
      onError: (path, error) => errors.push([path, error]),
    });

    expect(errors).toEqual([[bad, failure]]);
    expect(removed).toEqual([good]);
  });

  it("keeps a plain file with a valid review name", async () => {
    const file = join(root, "review-5-eeeeeeeeeeee");
    writeFileSync(file, "x");
    const when = new Date(NOW - REVIEW_CHECKOUT_MAX_AGE_MS * 5);
    utimesSync(file, when, when);

    const removed = await sweepReviewCheckouts({ root, now: () => NOW });

    expect(removed).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
});

describe("sweepReviewCheckouts without a root yet", () => {
  it("removes nothing and does not fail when the root does not exist", async () => {
    const missing = join(tmpdir(), "review-sweep-missing-root-never-created");

    await expect(sweepReviewCheckouts({ root: missing, now: () => NOW })).resolves.toEqual([]);
  });
});

describe("REVIEW_CHECKOUT_NAME", () => {
  it("matches the checkout name the reviewer brief tells reviewers to create", () => {
    expect(REVIEW_CHECKOUT_NAME.test(reviewCheckoutName(900, "0081c0d493fad60a9412b68f571bc279d79c527c"))).toBe(true);
  });
});
