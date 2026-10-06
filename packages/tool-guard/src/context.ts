import * as fs from "node:fs";
import * as path from "node:path";
import type { ClassifyContext } from "./types.js";

/** The read-only filesystem calls the hook makes. Nothing here, or anywhere in this package, writes a file. */
export interface ReadFs {
  realpath(p: string): string;
  readHead(p: string, max: number): string;
  isFile(p: string): boolean;
}

const SCRIPT_CAP = 64 * 1024;
const HEAD_CAP = 4096;
const MAX_DEPTH = 64;

/**
 * Node's own reads. `realpathSync.native` returns the on-disk spelling, so on a case-insensitive
 * filesystem `~/.NPMRC` resolves to the guarded `~/.npmrc`.
 */
export const NODE_FS: ReadFs = {
  realpath: (p) => fs.realpathSync.native(p),
  readHead: (p, max) => {
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(max);
      return buf.subarray(0, fs.readSync(fd, buf, 0, max, 0)).toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  },
  isFile: (p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false,
};

/** The classifier's context over a read-only filesystem. Every port returns null rather than throwing. */
export function nodeContext(home: string, rfs: ReadFs = NODE_FS): ClassifyContext {
  const realHome = attempt(() => rfs.realpath(home));
  return {
    home,
    readLink: (p) => attempt(() => inHomeSpelling(rfs.realpath(p), home, realHome)),
    readHead: (dir) => attempt(() => branchOf(dir, rfs)),
    // A regular file only: opening a FIFO such as `/dev/stdin` would block the hook.
    readScript: (p) => attempt(() => (rfs.isFile(p) ? rfs.readHead(p, SCRIPT_CAP) : null)),
  };
}

/** A home reached through a symlink (`/var` on macOS) resolves outside it; map it back so guarded `~/` paths still match. */
function inHomeSpelling(real: string, home: string, realHome: string | null): string {
  if (realHome === null || realHome === home) return real;
  if (real === realHome || real.startsWith(`${realHome}/`)) return home + real.slice(realHome.length);
  return real;
}

function attempt<T>(read: () => T | null): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** The checked-out branch: the nearest `.git` up from `dir`, followed through a worktree's `gitdir:` file. */
function branchOf(dir: string, rfs: ReadFs): string | null {
  let current = path.resolve(dir);
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const dotGit = path.join(current, ".git");
    const head = attempt(() => headFile(dotGit, rfs));
    if (head !== null) return /^ref: refs\/heads\/(.+)$/m.exec(rfs.readHead(head, HEAD_CAP))?.[1]?.trim() ?? null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function headFile(dotGit: string, rfs: ReadFs): string | null {
  if (!rfs.isFile(dotGit)) {
    const head = path.join(dotGit, "HEAD");
    return rfs.isFile(head) ? head : null;
  }
  const gitdir = /^gitdir: (.+)$/m.exec(rfs.readHead(dotGit, HEAD_CAP))?.[1]?.trim();
  return gitdir ? path.join(path.resolve(path.dirname(dotGit), gitdir), "HEAD") : null;
}
