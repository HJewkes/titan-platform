import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isExcludedDir, shouldIncludeFile } from "./parser/index.js";

/**
 * Recursively collect the source files under `rootDirs` that pass the ingest
 * filter for `languages`, deduped by absolute path across roots (walk order
 * preserved). Extracted from the indexer (C-61): as a function nested inside the
 * per-root loop, the recursive walker carried a cognitive-complexity nesting
 * bonus that made it the indexer's single most complex function (cx 19, above
 * the exported entry point). Hoisting it here — one recursion helper, one
 * directory branch — drops it well under budget and makes the walker unit-
 * testable in isolation.
 */
export async function walkSourceFiles(
  rootDirs: readonly string[],
  languages: readonly string[],
): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rootDir of rootDirs) {
    await collectFiles(rootDir, rootDir, languages, seen, out);
  }
  return out;
}

async function collectFiles(
  dir: string,
  rootDir: string,
  languages: readonly string[],
  seen: Set<string>,
  out: string[],
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // Prune excluded directories (node_modules, dist, .git, …) instead of
    // recursing into them: `shouldIncludeFile` already rejects every file
    // beneath them, so descending only pays to `readdir` a potentially multi-GB
    // tree and discard all of it. Pruning here changes no output but makes
    // `graph index` on a repo with installed dependencies orders of magnitude
    // faster (found dogfooding on a pnpm monorepo — a whole-repo index hung in
    // node_modules for minutes).
    if (entry.isDirectory()) {
      if (isExcludedDir(entry.name)) continue;
      await collectFiles(full, rootDir, languages, seen, out);
    } else if (entry.isFile() && !seen.has(full)) {
      const relative = path.relative(rootDir, full);
      if (shouldIncludeFile(relative, [...languages])) {
        seen.add(full);
        out.push(full);
      }
    }
  }
}
