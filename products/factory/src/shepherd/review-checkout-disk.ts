import { existsSync, lstatSync, readdirSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { REVIEW_CHECKOUT_NAME } from "./review-checkout-sweep.js";
import type { CheckoutDisk } from "./spawn-gate.js";

export type StatFs = (path: string) => { bsize: number; bavail: number; files: number; ffree: number };

/** A reviewer extracts its head straight after it creates the run dir, so a run dir untouched this long holds a whole checkout. */
const SETTLED_MS = 2 * 60_000;

interface ReviewCheckoutDiskDeps {
  statfs?: StatFs;
  now?: () => number;
}

/** The root does not exist until the first reviewer extracts into it, so its nearest existing ancestor names the filesystem. */
function nearestExisting(path: string): string {
  let at = path;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  return at;
}

/** The run dir and every entry under it, without following a symlink. */
function countInodes(dir: string): number {
  let count = 1;
  const pending = [dir];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const entry of readdirSync(next, { withFileTypes: true })) {
      count++;
      if (entry.isDirectory()) pending.push(join(next, entry.name));
    }
  }
  return count;
}

/**
 * Nothing records a checkout's size, so each settled run dir under `root` is measured once, while its reviewer still holds it;
 * the newest measurement outlives the dir, because a reviewer removes its own checkout at its verdict.
 */
function checkoutSizer(root: string, now: () => number): () => number | undefined {
  const measured = new Map<string, number>();
  let last: { at: number; inodes: number } | undefined;
  return () => {
    const names = existsSync(root) ? readdirSync(root).filter((name) => REVIEW_CHECKOUT_NAME.test(name)) : [];
    for (const name of measured.keys()) if (!names.includes(name)) measured.delete(name);
    for (const name of names.filter((candidate) => !measured.has(candidate))) {
      const size = settledSize(join(root, name), now());
      if (size === undefined) continue;
      measured.set(name, size.inodes);
      if (!last || size.at >= last.at) last = size;
    }
    return last?.inodes;
  };
}

/** A run dir its reviewer removed mid-walk is no measurement, and must not cost the filesystem reading. */
function settledSize(dir: string, now: number): { at: number; inodes: number } | undefined {
  try {
    const info = lstatSync(dir);
    if (!info.isDirectory() || now - info.mtimeMs < SETTLED_MS) return undefined;
    return { at: info.mtimeMs, inodes: countInodes(dir) };
  } catch {
    return undefined;
  }
}

/** The free room on the filesystem that holds `root`, and the last checkout's inodes; a failed read leaves the reading out. */
export function reviewCheckoutDisk(root: string, deps: ReviewCheckoutDiskDeps = {}): () => CheckoutDisk {
  const { statfs = statfsSync, now = Date.now } = deps;
  const lastCheckoutInodes = checkoutSizer(root, now);
  return () => {
    try {
      const fs = statfs(nearestExisting(root));
      const inodes = fs.files > 0 ? { freeInodes: fs.ffree, totalInodes: fs.files } : {};
      const last = lastCheckoutInodes();
      return { freeBytes: fs.bavail * fs.bsize, ...inodes, ...(last !== undefined && { lastCheckoutInodes: last }) };
    } catch {
      return {};
    }
  };
}
