import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewCheckoutDisk, type StatFs } from "./review-checkout-disk.js";

const statfs: StatFs = () => ({ bsize: 4096, bavail: 1_000, files: 10_000, ffree: 4_000 });

describe("reviewCheckoutDisk", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "titan-checkout-disk-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A run dir of `files` files under head/, last touched `ageMs` before `now`. */
  const checkout = (root: string, name: string, files: number, ageMs: number, now: number) => {
    const head = join(root, name, "head");
    mkdirSync(head, { recursive: true });
    for (let index = 0; index < files; index++) writeFileSync(join(head, `f${index}`), "");
    const at = (now - ageMs) / 1000;
    utimesSync(join(root, name), at, at);
  };

  it("reads free bytes and inodes of the filesystem holding the root, from its nearest existing ancestor before the first checkout", () => {
    const seen: string[] = [];
    const root = join(dir, "checkouts", "reviews");
    const read = reviewCheckoutDisk(root, { statfs: (path) => (seen.push(path), statfs(path)) });

    expect(read()).toEqual({ freeBytes: 4_096_000, freeInodes: 4_000, totalInodes: 10_000 });
    expect(seen).toEqual([dir]);
  });

  it("records the newest settled checkout's inode count, and keeps it after the checkout is removed", () => {
    const now = 10_000_000;
    checkout(dir, "review-7-aaaaaaaaaaaa", 4, 10 * 60_000, now);
    checkout(dir, "review-8-bbbbbbbbbbbb", 2, 5 * 60_000, now);
    const read = reviewCheckoutDisk(dir, { statfs, now: () => now });

    expect(read().lastCheckoutInodes).toBe(4);
    rmSync(join(dir, "review-8-bbbbbbbbbbbb"), { recursive: true });
    expect(read().lastCheckoutInodes).toBe(4);
  });

  it("does not measure a checkout still being extracted, or an entry that is no checkout", () => {
    const now = 10_000_000;
    checkout(dir, "review-7-aaaaaaaaaaaa", 4, 30_000, now);
    checkout(dir, "scratch", 9, 10 * 60_000, now);

    expect(reviewCheckoutDisk(dir, { statfs, now: () => now })().lastCheckoutInodes).toBeUndefined();
  });

  it("leaves the inode reading out on a filesystem with no fixed inode table", () => {
    const read = reviewCheckoutDisk(dir, { statfs: () => ({ bsize: 4096, bavail: 1_000, files: 0, ffree: 0 }) });

    expect(read()).toEqual({ freeBytes: 4_096_000 });
  });

  it("answers no reading when the filesystem cannot be read", () => {
    const read = reviewCheckoutDisk(dir, { statfs: () => { throw new Error("EIO"); } });

    expect(read()).toEqual({});
  });
});
