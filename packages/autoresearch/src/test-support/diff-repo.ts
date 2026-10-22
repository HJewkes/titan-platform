import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnifiedDiff, type DiffFile } from "../diff.js";
import { git, SEED_FILES, writeFiles } from "./fake-ports.js";

export interface Change {
  /** Path to its full new text; `null` deletes the file. */
  write?: Record<string, string | null>;
  rename?: Record<string, string>;
}

interface RealDiff {
  text: string;
  files: DiffFile[];
  /** A path's text at the base and at the head commit, read with `git show`. */
  at(rev: "base" | "head", path: string): string;
}

/** Two commits in a fresh repo seeded with `SEED_FILES`, and the diff a host's L0 port would read between them. */
export async function realDiff(change: Change): Promise<RealDiff> {
  const dir = mkdtempSync(join(tmpdir(), "ar-diff-"));
  try {
    await git(dir, "init", "--quiet", "-b", "main");
    writeFiles(dir, SEED_FILES);
    await git(dir, "add", "--all");
    await git(dir, "commit", "--quiet", "-m", "base");
    for (const [from, to] of Object.entries(change.rename ?? {})) await git(dir, "mv", from, to);
    for (const [path, text] of Object.entries(change.write ?? {})) {
      if (text === null) rmSync(join(dir, path));
      else writeFiles(dir, { [path]: text });
    }
    await git(dir, "add", "--all");
    await git(dir, "commit", "--quiet", "-m", "head");
    const text = await git(dir, "diff", "--no-color", "--unified=0", "-M", "HEAD~1", "HEAD");
    const shown = new Map<string, string>();
    for (const path of Object.keys(change.write ?? {})) {
      for (const [rev, ref] of [["base", "HEAD~1"], ["head", "HEAD"]] as const) shown.set(`${rev}:${path}`, await git(dir, "show", `${ref}:${path}`).catch(() => ""));
    }
    return { text, files: parseUnifiedDiff(text), at: (rev, path) => shown.get(`${rev}:${path}`) ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
