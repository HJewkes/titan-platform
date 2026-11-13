import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { BriefFrontmatterSchema } from '../schemas/brief.js';
import { expandTilde } from '../utils/paths.js';
import { readRegisteredWorktrees } from '../utils/registered-worktrees.js';
import { readMarkdownWithSchema } from '../utils/markdown-schema.js';
/**
 * List initiative slugs (immediate, non-dotfile subdirectories of the root).
 * A missing root is empty; any other read error (EACCES, ENOTDIR) propagates so
 * a lint or scan over an unreadable root cannot pass clean.
 */
export async function listInitiativeSlugs(activeRoot: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(activeRoot, { withFileTypes: true });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/** Whether `slug` names an initiative directory, read by path rather than by listing the root. */
export async function isInitiativeSlug(activeRoot: string, slug: string): Promise<boolean> {
  if (slug.startsWith('.') || slug.includes('/') || slug.includes(path.sep)) return false;
  return fs.stat(path.join(activeRoot, slug)).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
}

/** For callers that must degrade to "no initiatives" rather than fail (launch, lookups, doctor, boards). */
export async function listInitiativeSlugsOrEmpty(activeRoot: string): Promise<string[]> {
  try {
    return await listInitiativeSlugs(activeRoot);
  } catch {
    return [];
  }
}

/**
 * The initiative's own directory under the active root — where an interactive
 * Claude session launches, always, regardless of what worktrees are
 * registered. Used by the `aw` launcher and `resume`.
 *
 * Deliberately not `resolveCwdHint`. Registering a worktree is a statement
 * about where *dispatched agents* need to run (they must be in a git repo to
 * commit); it is not a request to move the operator's own sessions out of the
 * initiative's notes and state. Those two were one value until AW-115, so
 * `active-work worktree set example-app ~/projects/example` — run to fix
 * dispatch — silently relocated every subsequent `aw example-app` as well.
 */
export function resolveLaunchCwd(activeRoot: string, slug: string): string {
  return path.join(activeRoot, slug);
}

/** True when `child` is `parent` itself or nested beneath it. */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Canonicalize a path via `realpath`, falling back to a lexical resolve when
 * the path doesn't exist yet. Needed because `process.cwd()` returns the
 * symlink-resolved path on macOS (e.g. `/var` → `/private/var`) while a brief
 * may store the un-resolved form — matching them requires both canonicalized.
 */
async function canonicalize(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Read purely as a validity gate: an initiative whose brief will not parse is
 * skipped rather than resolved into.
 */
async function hasValidBrief(activeRoot: string, slug: string): Promise<boolean> {
  const briefPath = path.join(activeRoot, slug, 'brief.md');
  try {
    await readMarkdownWithSchema(briefPath, BriefFrontmatterSchema);
    return true;
  } catch {
    return false;
  }
}

interface CwdMatch {
  slug: string;
  worktreePath: string;
}

/**
 * Resolve an initiative from a working directory by matching it against every
 * initiative's worktree paths. When `cwd` sits inside more than one worktree
 * (e.g. nested checkouts) the deepest — longest — worktree path wins. Returns
 * the matched slug and (display-form) worktree path, or null when nothing
 * matches or two initiatives tie at the same depth (ambiguous → fall back to
 * the picker).
 *
 * Both sides are canonicalized with `realpath` so symlinked paths still match.
 * Relative worktree paths are skipped, since they cannot be compared against
 * an absolute cwd deterministically.
 */
export async function resolveSlugFromCwd(
  activeRoot: string,
  cwd: string,
): Promise<CwdMatch | null> {
  const resolvedCwd = await canonicalize(cwd);
  const slugs = await listInitiativeSlugsOrEmpty(activeRoot);
  let best: { slug: string; worktreePath: string; depth: number } | null = null;
  let tiedAtBest = false;

  for (const slug of slugs) {
    if (!(await hasValidBrief(activeRoot, slug))) continue;
    // Only *registered* worktrees resolve a cwd. Swept ones are observations,
    // not a claim that this directory belongs to the initiative (AW-67).
    const registered = await readRegisteredWorktrees(path.join(activeRoot, slug));
    for (const entry of registered) {
      const displayPath = expandTilde(entry.path);
      if (!path.isAbsolute(displayPath)) continue;
      const canonical = await canonicalize(displayPath);
      if (!isInside(resolvedCwd, canonical)) continue;
      const depth = canonical.length;
      if (best === null || depth > best.depth) {
        best = { slug, worktreePath: displayPath, depth };
        tiedAtBest = false;
      } else if (depth === best.depth && slug !== best.slug) {
        tiedAtBest = true;
      }
    }
  }

  if (best === null || tiedAtBest) return null;
  return { slug: best.slug, worktreePath: best.worktreePath };
}
