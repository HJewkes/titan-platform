import path from 'node:path';
import { expandTilde } from '../utils/paths.js';
import { readRegisteredWorktrees, defaultWorktreePath } from '../utils/registered-worktrees.js';
import { NotFoundError } from '../errors.js';
import { listFacets, type LoadedFacet } from '../facets/facet-file.js';
import { listInitiativeSlugsOrEmpty } from '../sessions/initiatives.js';

/**
 * Resolve a user-supplied slug (exact or unique prefix) to a full slug.
 * Throws NotFoundError on no match, and on an ambiguous prefix.
 */
export async function resolveSlug(activeRoot: string, input: string): Promise<string> {
  const slugs = await listInitiativeSlugsOrEmpty(activeRoot);
  if (slugs.includes(input)) return input;
  return matchSlugPrefix(activeRoot, slugs, input, []);
}

interface SlugResolution {
  slug: string;
  facet?: LoadedFacet;
}

/**
 * `resolveSlug`, plus facet aliases (TP-326). Order: an initiative directory,
 * then an exact facet alias, then a slug prefix. An alias equal to an
 * initiative slug is therefore shadowed; `facet list` flags it.
 */
export async function resolveSlugOrFacet(
  activeRoot: string,
  input: string,
): Promise<SlugResolution> {
  const slugs = await listInitiativeSlugsOrEmpty(activeRoot);
  if (slugs.includes(input)) return { slug: input };
  const { facets } = await listFacets(activeRoot, slugs);
  const facet = facets.find((f) => f.name === input);
  if (facet) return { slug: facet.owner, facet };
  const aliases = facets.map((f) => `${f.name} (${f.owner})`);
  return { slug: matchSlugPrefix(activeRoot, slugs, input, aliases) };
}

function matchSlugPrefix(
  activeRoot: string,
  slugs: string[],
  input: string,
  aliases: string[],
): string {
  const matches = slugs.filter((s) => s.startsWith(input));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new NotFoundError(`Ambiguous slug '${input}'. Candidates: ${matches.join(', ')}`);
  }
  if (slugs.length === 0) {
    throw new NotFoundError(`No initiatives found under ${activeRoot}`, { reason: 'no_match' });
  }
  const facetList = aliases.length > 0 ? `. Facets: ${aliases.join(', ')}` : '';
  throw new NotFoundError(
    `No initiative matches '${input}'. Known: ${slugs.join(', ')}${facetList}`,
    { reason: 'no_match' },
  );
}

/**
 * The initiative's preferred registered worktree, or its active-root directory
 * when none is registered.
 *
 * This is the *dispatch* answer, surfaced as `cwd_hint` on `open`'s JSON
 * envelope and consumed by out-of-process callers that need a git checkout,
 * such as a dispatcher resolving an item's working directory. The launcher
 * deliberately does not use it; see
 * `resolveLaunchCwd`.
 */
export async function resolveCwdHint(activeRoot: string, slug: string): Promise<string> {
  const registered = await readRegisteredWorktrees(path.join(activeRoot, slug));
  const preferred = defaultWorktreePath(registered);
  return preferred === null ? path.join(activeRoot, slug) : expandTilde(preferred);
}
