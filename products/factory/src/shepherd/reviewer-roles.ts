import { DEFAULT_CLASS_ROLES } from "@titan-design/review-panel";
import type { ClassRoles, ReviewerFacts } from "@titan-design/review-panel";

/** The charter's G10 rule picks the class: a registered `security` kind, or a diff over `G10_CHANGED_LINES`. Everything else is `standard`. */
type ReviewerClass = "g10" | "standard";

export type { ReviewerFacts };

export type ReviewerRoles = ClassRoles;

const G10_CHANGED_LINES = 400;

export const DEFAULT_REVIEWER_ROLES: ReviewerRoles = DEFAULT_CLASS_ROLES;

export function reviewerClassFor({ kind, unread, changedLines }: ReviewerFacts): ReviewerClass {
  return unread || kind === "security" || (changedLines !== undefined && changedLines > G10_CHANGED_LINES) ? "g10" : "standard";
}

export function reviewerRoleFor(facts: ReviewerFacts, roles: ReviewerRoles = DEFAULT_REVIEWER_ROLES): string {
  return roles[reviewerClassFor(facts)];
}

/** A class the config leaves out, or a config with no table, keeps the one `profile` it had before the table. */
export function configuredRoles(review: { profile: string; roles?: Partial<ReviewerRoles> }): ReviewerRoles {
  return { g10: review.roles?.g10 ?? review.profile, standard: review.roles?.standard ?? review.profile };
}
