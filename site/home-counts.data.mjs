/**
 * The landing page's package and test-file counts, computed when the site builds rather than committed as text.
 * A committed repo-wide test count went stale whenever concurrent PRs together crossed a hundred, which turned
 * main's docs:build red and made test-only PRs commit regenerated copies of site/index.md (TP-3759).
 *
 * A VitePress data loader. The hero tagline lives in frontmatter, which the theme renders before any page script,
 * so `.vitepress/config.mts` fills it from `load()` in `transformPageData` instead of `import { data }`.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collect, packageCount } from "../scripts/gen-docs-reference.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const WORKSPACE_ROOTS = ["packages", "products", "apps", "deploy/hub"];
const UNTRACKED_DIRS = new Set(["node_modules", "dist", "coverage"]);

export function countTestFiles(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || UNTRACKED_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) count += countTestFiles(path);
    else if (/\.test\.[^.]+$/.test(name)) count += 1;
  }
  return count;
}

/** Floored to the hundred, so the page reads as a round figure rather than an exact count that drifts weekly. */
export function roundedTestCount(count) {
  return `${(Math.floor(count / 100) * 100).toLocaleString("en-US")}+`;
}

/** Test files under the workspace globs; build output and installed dependencies are not source. */
export function homeCounts(base) {
  const tests = WORKSPACE_ROOTS.reduce((sum, dir) => sum + countTestFiles(join(base, dir)), 0);
  return { "package-count": packageCount(collect(base)), "test-file-count": roundedTestCount(tests) };
}

/** Replaces each `{name}` token with its count; a missing token throws so a reworded tagline cannot drop one silently. */
export function fillCounts(text, counts) {
  let out = text;
  for (const [name, value] of Object.entries(counts)) {
    if (!out.includes(`{${name}}`)) throw new Error(`no {${name}} token in: ${text}`);
    out = out.replaceAll(`{${name}}`, value);
  }
  return out;
}

export default {
  load: () => homeCounts(repoRoot),
};
