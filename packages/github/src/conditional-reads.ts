import { GhError } from "./exec.js";
import type { Rest } from "./rest.js";
import { isFreePlanRefusal } from "./rules-read.js";

/** A branch tip, or `notModified` when it is unchanged since the read that answered `etag`; a missing branch reads as a null `sha`. */
export type RefRead = { notModified: true } | { notModified: false; sha: string | null; etag: string | null };

/**
 * Ruleset id to its `updated_at`, or `notModified` when the list is unchanged since the read that answered `etag`.
 * `unreadable` is a private repo on the free plan, which GitHub refuses rulesets with a 403: its rulesets are unknown, never none.
 */
export type RulesetList =
  | { notModified: true }
  | { notModified: false; unreadable: true }
  | { notModified: false; unreadable: false; rulesets: Record<number, string>; etag: string | null };

interface GhRuleset {
  id: number;
  updated_at?: string;
}

export async function revalidateRef(api: Rest, repo: string, branch: string, etag: string | null): Promise<RefRead> {
  try {
    const read = await api.revalidatePages(`repos/${repo}/git/ref/heads/${branch}`, {}, etag, (ref: { object: { sha: string } }) => [ref.object.sha]);
    return read.notModified ? read : { notModified: false, sha: read.body[0] ?? null, etag: read.etag };
  } catch (error) {
    if (error instanceof GhError && error.status === 404) return { notModified: false, sha: null, etag: null };
    throw error;
  }
}

export async function revalidateRulesets(api: Rest, repo: string, etag: string | null): Promise<RulesetList> {
  let read;
  try {
    read = await api.revalidatePages(`repos/${repo}/rulesets`, { per_page: "100" }, etag, (page: GhRuleset[]) => page);
  } catch (error) {
    if (isFreePlanRefusal(error)) return { notModified: false, unreadable: true };
    throw error;
  }
  if (read.notModified) return read;
  const rulesets: Record<number, string> = {};
  for (const ruleset of read.body) rulesets[ruleset.id] = ruleset.updated_at ?? (await detailUpdatedAt(api, repo, ruleset.id));
  return { notModified: false, unreadable: false, rulesets, etag: read.etag };
}

/** GitHub's list rows carry `updated_at` today; a row without one is read in full rather than guessed. */
async function detailUpdatedAt(api: Rest, repo: string, id: number): Promise<string> {
  const detail = await api.get<GhRuleset>(`repos/${repo}/rulesets/${id}`);
  if (typeof detail.updated_at !== "string") throw new Error(`ruleset ${id} answered no updated_at, so whether it changed is unknown`);
  return detail.updated_at;
}
