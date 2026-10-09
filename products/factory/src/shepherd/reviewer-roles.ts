import type { PrFile } from "@titan-design/github";
import { changedLineCount, DEFAULT_CLASS_ROLES, DEFAULT_CLASS_RULES } from "@titan-design/review-panel";
import type { ClassRoles, ReviewerFacts } from "@titan-design/review-panel";

/** The charter's G10 rule picks the class: a registered `security` kind, or a diff over the changed-line limit. Everything else is `standard`. */
type ReviewerClass = "g10" | "standard";

export type { ReviewerFacts };

export type ReviewerRoles = ClassRoles & {
  /** A PR over this many changed lines is g10; absent means `G10_CHANGED_LINES`. */
  g10ChangedLines?: number;
};

/** The panel's large-PR limit, so Shepherd and `planPanel` class the same diff alike. */
const G10_CHANGED_LINES = DEFAULT_CLASS_RULES.largeLines;

export const DEFAULT_REVIEWER_ROLES: ReviewerRoles = DEFAULT_CLASS_ROLES;

export function reviewerClassFor({ kind, unread, changedLines }: ReviewerFacts, limit: number = G10_CHANGED_LINES): ReviewerClass {
  return unread || kind === "security" || (changedLines !== undefined && changedLines > limit) ? "g10" : "standard";
}

export function reviewerRoleFor(facts: ReviewerFacts, roles: ReviewerRoles = DEFAULT_REVIEWER_ROLES): string {
  return roles[reviewerClassFor(facts, roles.g10ChangedLines)];
}

/** A PR's changed lines with generated registry files left out; undefined when a counted file carries no line counts. */
export function prChangedLines(files: readonly PrFile[]): number | undefined {
  return changedLineCount(files.map(({ path, additions, deletions }) => ({ path, additions: additions ?? Number.NaN, deletions: deletions ?? Number.NaN })));
}

/** A class the config leaves out, or a config with no table, keeps the one `profile` it had before the table. */
export function configuredRoles(review: { profile: string; roles?: Partial<ClassRoles>; g10ChangedLines?: number }): ReviewerRoles {
  const limit = review.g10ChangedLines;
  return { g10: review.roles?.g10 ?? review.profile, standard: review.roles?.standard ?? review.profile, ...(limit !== undefined && { g10ChangedLines: limit }) };
}
