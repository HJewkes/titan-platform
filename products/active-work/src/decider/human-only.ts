import type { ExclusionPolicy } from '@titan-design/decider';

/**
 * The decider package never reads the charter; active-work reads the human-only
 * list (`sessions/charter.ts`) and passes it in as this policy.
 */
export function exclusionPolicy(humanOnly: ReadonlySet<string>): ExclusionPolicy {
  return { humanOnlyInitiatives: [...humanOnly], projectInitiatives: [], personalDataPatterns: [] };
}
