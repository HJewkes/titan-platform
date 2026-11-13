import { HumanOnlyUnreadableError, loadHumanOnlyInitiatives } from '../decider/human-only.js';
import { UsageError } from '../errors.js';
import type { CommandContext } from '../registry/types.js';
import { listSlugsForCaller } from '../sessions/visibility.js';
import { getActiveRoot } from '../utils/paths.js';
import { validateSlug } from '../utils/slug.js';

interface ListScope {
  slug?: string;
  all_initiatives?: boolean;
}

interface HumanOnlyPredicate {
  known: boolean;
  isHumanOnly: (slug: string) => boolean;
}

/**
 * The initiatives a list command reads: one slug, or every one with `all_initiatives`, less
 * the owner-only ones when an agent asks. A named slug is read by path, as a session reads its own.
 */
export async function resolveListSlugs(
  command: string,
  scope: ListScope,
  ctx: Pick<CommandContext, 'caller' | 'warnings'>,
): Promise<string[]> {
  if (scope.all_initiatives && scope.slug) {
    throw new UsageError(`${command} takes a slug or --all-initiatives, not both`);
  }
  if (scope.all_initiatives) {
    const activeRoot = getActiveRoot();
    return listSlugsForCaller(activeRoot, ctx);
  }
  if (!scope.slug) throw new UsageError(`${command} requires a slug or --all-initiatives`);
  const slugCheck = validateSlug(scope.slug);
  if (!slugCheck.ok) throw new UsageError(`Invalid slug '${scope.slug}': ${slugCheck.error}`);
  return [scope.slug];
}

function unreadableCharterWarning(err: unknown): string {
  if (err instanceof HumanOnlyUnreadableError) {
    return `Cannot read human_only_initiatives from ${err.file}; every initiative is flagged human_only: ${err.reason}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Fails closed: an unreadable charter flags every initiative, so nothing personal leaks into an export. */
export async function humanOnlyPredicate(
  activeRoot: string,
  warnings: string[],
): Promise<HumanOnlyPredicate> {
  try {
    const humanOnly = await loadHumanOnlyInitiatives(activeRoot);
    return { known: true, isHumanOnly: (slug) => humanOnly.has(slug) };
  } catch (err) {
    warnings.push(unreadableCharterWarning(err));
    return { known: false, isHumanOnly: () => true };
  }
}
