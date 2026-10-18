import { execFileSync } from "node:child_process";
import { isFullSha, splitLines, type LineSource } from "@titan-design/evidence";
import { gitEnv, runGit } from "./git.js";

const BLOB_READ_BUFFER = 1024 * 1024 * 1024;
const BATCH_HEADER = /^[0-9a-f]{40,64} (\S+) (\d+)$/;
// `<rev>:./x` and `<rev>:../x` resolve against the cwd, and a line break would split the batch request.
const UNREADABLE_PATH = /^\.{1,2}\/|^\/|[\r\n\0]/;

// --no-replace-objects: a `git replace` entry must not swap the pinned bytes for others.
const CAT_FILE = ["--no-replace-objects", "cat-file"];

function parseBlob(out: Buffer): string | undefined {
  const eol = out.indexOf(0x0a);
  if (eol < 0) return undefined;
  const header = BATCH_HEADER.exec(out.toString("utf-8", 0, eol));
  if (!header || header[1] !== "blob") return undefined;
  const start = eol + 1;
  return out.toString("utf-8", start, start + Number(header[2]));
}

function readLinesAt(repoRoot: string, rev: string, path: string): string[] | undefined {
  if (path === "" || UNREADABLE_PATH.test(path)) return undefined;
  const out = execFileSync("git", [...CAT_FILE, "--batch"], {
    cwd: repoRoot,
    input: `${rev}:${path}\n`,
    maxBuffer: BLOB_READ_BUFFER,
    stdio: ["pipe", "pipe", "ignore"],
    env: gitEnv(repoRoot),
  });
  const text = parseBlob(out);
  return text === undefined ? undefined : splitLines(text);
}

/**
 * A LineSource over the blobs of commit `rev`, never the working tree. `rev` must be a full 40-hex
 * commit id, so a moving ref cannot change what an anchor was checked against. A path that is not a
 * blob at `rev` (missing, a directory, a submodule) reads as unreadable.
 */
export function revisionLineSource(repoRoot: string, rev: string): LineSource {
  if (!isFullSha(rev)) throw new Error(`revisionLineSource needs a 40-hex commit id, not "${rev}"`);
  if (runGit(repoRoot, [...CAT_FILE, "-t", rev]) !== "commit") throw new Error(`${rev} is not a commit in ${repoRoot}`);
  const cache = new Map<string, string[] | undefined>();
  return {
    lines(path) {
      if (!cache.has(path)) cache.set(path, readLinesAt(repoRoot, rev, path));
      return cache.get(path);
    },
  };
}
