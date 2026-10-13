import type { GitHubPort, RepoSlug } from "@titan-design/github";

/**
 * How the PR's files relate to main's delta since its fork point, by unit (`packages/*`, `products/*`, `apps/*`).
 * `units-disjoint` compares the units directly, with no workspace dependency closure, so it over-counts what the
 * disjoint skip would allow: the closure is that slice's rule. `shared` is a path every unit depends on.
 */
export type DisjointVerdict = "units-disjoint" | "overlap" | "shared" | "unknown";

const UNIT = /^(?:packages|products|apps)\/[^/]+\//;

/** The paths `scripts/test-affected.mjs` forces a full rerun on, plus CI and the scripts tree. */
const SHARED = [/(^|\/)package\.json$/, /(^|\/)pnpm-lock\.yaml$/, /(^|\/)tsconfig[^/]*\.json$/, /(^|\/)(vitest|vite)\.config\.[^/]+$/, /^\.github\//, /^scripts\//];

/** The unit a path belongs to, or null for a shared path: any root path, or one on the shared list. */
function unitOf(path: string): string | null {
  if (SHARED.some((pattern) => pattern.test(path))) return null;
  return UNIT.exec(path)?.[0] ?? null;
}

/** Pure: a shared path on either side wins over a unit overlap, which wins over disjoint units. */
export function disjointVerdict(prFiles: readonly string[], delta: readonly string[]): DisjointVerdict {
  const pr = prFiles.map(unitOf);
  const main = delta.map(unitOf);
  if (pr.includes(null) || main.includes(null)) return "shared";
  const units = new Set(pr);
  return main.some((unit) => units.has(unit)) ? "overlap" : "units-disjoint";
}

/** Two reads: the PR's files, and main's files since the head's fork point. A truncated compare cannot be judged. */
export async function readDisjoint(port: GitHubPort, repo: RepoSlug, pr: number, headSha: string, base: string): Promise<DisjointVerdict> {
  const files = await port.listPrFiles(repo, pr);
  const delta = await port.compareFiles(repo, headSha, base);
  if (delta.truncated) return "unknown";
  return disjointVerdict(
    files.flatMap((file) => [file.path, ...(file.previousPath ? [file.previousPath] : [])]),
    delta.files,
  );
}
