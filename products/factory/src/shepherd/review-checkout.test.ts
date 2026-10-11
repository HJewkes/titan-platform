import { describe, expect, it } from "vitest";
import { removeReviewCheckout, reviewCheckoutDir, reviewCheckoutRoot } from "./review-checkout.js";

// Built from parts so no literal home path sits in the source.
const linuxHome = ["", "srv", "agent"].join("/");
const macHome = ["", "srv", "mac-agent"].join("/");
const target = { pr: 765, head: "4609b824f20c0123456789abcdef0123456789ab" };

describe("reviewCheckoutRoot", () => {
  it("is under the titan-factory data dir on linux", () => {
    expect(reviewCheckoutRoot({ platform: "linux", home: linuxHome, env: {} })).toBe(`${linuxHome}/.local/share/titan-factory/checkouts/reviews`);
  });

  it("is under Application Support on darwin", () => {
    expect(reviewCheckoutRoot({ platform: "darwin", home: macHome, env: {} })).toBe(`${macHome}/Library/Application Support/titan-factory/checkouts/reviews`);
  });

  it("ignores TMPDIR and the cache dirs", () => {
    const root = reviewCheckoutRoot({ platform: "linux", home: linuxHome, env: { TMPDIR: "/tmp", XDG_CACHE_HOME: `${linuxHome}/.cache` } });

    expect(root).not.toContain("/tmp");
    expect(root).not.toContain(".cache");
  });
});

describe("removeReviewCheckout", () => {
  it("removes the whole run dir, which holds the head and base checkouts", async () => {
    const removed: string[] = [];

    const error = await removeReviewCheckout("/data/reviews", target, async (path) => void removed.push(path));

    expect(removed).toEqual([reviewCheckoutDir("/data/reviews", target)]);
    expect(removed[0]).toBe("/data/reviews/review-765-4609b824f20c");
    expect(error).toBeUndefined();
  });

  it("returns the failure instead of throwing, so a verdict survives it", async () => {
    const boom = new Error("EBUSY");

    const error = await removeReviewCheckout("/data/reviews", target, async () => {
      throw boom;
    });

    expect(error).toBe(boom);
  });
});
