import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Only full shas reach git, so no ref or option text from a caller is ever parsed by it. */
const SHA = /^[0-9a-f]{40}$/;
const MAX_PATCH_BYTES = 64 * 1024 * 1024;

export interface IdeaDiff {
  stat: { files: number; insertions: number; deletions: number };
  patch: string;
  truncated: boolean;
}

const git = async (clone: string, ...args: string[]) => (await run("git", ["-C", clone, ...args], { maxBuffer: MAX_PATCH_BYTES })).stdout;

/** Totals from `--numstat`; a binary file counts as a file with no lines. */
function statOf(numstat: string): IdeaDiff["stat"] {
  const rows = numstat.split("\n").filter(Boolean).map((line) => line.split("\t"));
  const lines = (column: 0 | 1) => rows.reduce((sum, row) => sum + (row[column] === "-" ? 0 : Number(row[column])), 0);
  return { files: rows.length, insertions: lines(0), deletions: lines(1) };
}

/** An idea's diff in the local clone of its target, the patch cut at `capBytes`. */
export async function ideaDiff(clone: string, base: string, head: string, capBytes = 256 * 1024): Promise<IdeaDiff> {
  if (!SHA.test(base) || !SHA.test(head)) throw new Error(`[diff-sha] expected two full shas, got ${base}..${head}`);
  const range = ["--no-color", "--no-ext-diff", "--no-renames", base, head];
  const stat = statOf(await git(clone, "diff", "--numstat", ...range));
  const full = Buffer.from(await git(clone, "diff", ...range));
  const truncated = full.length > capBytes;
  return { stat, patch: (truncated ? full.subarray(0, capBytes) : full).toString("utf8"), truncated };
}
