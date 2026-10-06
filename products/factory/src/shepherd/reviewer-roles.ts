/** The charter's G10 rule picks the class: a registered `security` kind, or a diff over `G10_CHANGED_LINES`. Everything else is `standard`. */
export type ReviewerClass = "g10" | "standard";

export interface ReviewerFacts {
  /** The run's registered kind. */
  kind?: string;
  /** Additions plus deletions. Nothing populates it until the github port reports line counts (TP-1755), so the size rule is idle until then. */
  changedLines?: number;
}

/** One agent-chat profile per class; the profile carries the reviewer's model and effort. */
export type ReviewerRoles = Record<ReviewerClass, string>;

export const G10_CHANGED_LINES = 400;

export const DEFAULT_REVIEWER_ROLES: ReviewerRoles = { g10: "bd-reviewer", standard: "reviewer" };

export function reviewerClassFor({ kind, changedLines }: ReviewerFacts): ReviewerClass {
  return kind === "security" || (changedLines !== undefined && changedLines > G10_CHANGED_LINES) ? "g10" : "standard";
}

export function reviewerRoleFor(facts: ReviewerFacts, roles: ReviewerRoles = DEFAULT_REVIEWER_ROLES): string {
  return roles[reviewerClassFor(facts)];
}

/** A class the config leaves out, or a config with no table, keeps the one `profile` it had before the table. */
export function configuredRoles(review: { profile: string; roles?: Partial<ReviewerRoles> }): ReviewerRoles {
  return { g10: review.roles?.g10 ?? review.profile, standard: review.roles?.standard ?? review.profile };
}
