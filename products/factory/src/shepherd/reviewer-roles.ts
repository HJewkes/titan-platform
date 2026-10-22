import type { PrFile } from "@titan-design/github";
import { changedLineCount, pathTouches, touchesDependency, DEFAULT_CLASS_ROLES, DEFAULT_CLASS_RULES } from "@titan-design/review-panel";
import type { ClassRoles, ReviewerFacts as PanelReviewerFacts } from "@titan-design/review-panel";

/**
 * The charter's G10 rule picks the class: a registered `security` kind, a G10 hold, a dependency or store-migration touch,
 * or a diff over the changed-line limit. Everything else is `standard`.
 */
type ReviewerClass = "g10" | "standard";

export type ReviewerFacts = PanelReviewerFacts & {
  /** The PR changes a store migration; review policy 458 holds it no more, so this fact alone keeps it on the g10 reviewer. */
  migrationTouch?: boolean;
};

const SHEPHERD_MIGRATION_FILES = ["store.ts", "events.ts", "train.ts"].map((name) => `products/factory/src/shepherd/${name}`);
/** Factory's store migrations live in plain source files, which the panel's default migration globs miss. */
const MIGRATION_RULES = { ...DEFAULT_CLASS_RULES, migration: [...DEFAULT_CLASS_RULES.migration, "**/store-migrations.ts", "**/*-migration*.ts", "**/*-store.ts", ...SHEPHERD_MIGRATION_FILES] };

export type ReviewerRoles = ClassRoles & {
  /** A PR over this many changed lines is g10; absent means `G10_CHANGED_LINES`. */
  g10ChangedLines?: number;
};

/** The panel's large-PR limit, so Shepherd and `planPanel` class the same diff alike. */
const G10_CHANGED_LINES = DEFAULT_CLASS_RULES.largeLines;

export const DEFAULT_REVIEWER_ROLES: ReviewerRoles = DEFAULT_CLASS_ROLES;

export function reviewerClassFor(facts: ReviewerFacts, limit: number = G10_CHANGED_LINES): ReviewerClass {
  const { kind, unread, sizeUnread, changedLines, dependencyTouch, migrationTouch, g10Hold } = facts;
  const touched = dependencyTouch === true || migrationTouch === true || g10Hold === true;
  return unread || sizeUnread || touched || kind === "security" || (changedLines !== undefined && changedLines > limit) ? "g10" : "standard";
}

export function reviewerRoleFor(facts: ReviewerFacts, roles: ReviewerRoles = DEFAULT_REVIEWER_ROLES): string {
  return roles[reviewerClassFor(facts, roles.g10ChangedLines)];
}

/** A PR's changed lines as `changedLineCount` counts them against `limit`; undefined when a file carries no line counts. */
export function prChangedLines(files: readonly PrFile[], limit: number = G10_CHANGED_LINES): number | undefined {
  const changed = files.map(({ path, previousPath, additions, deletions }) => ({ path, ...(previousPath !== undefined && { previousPath }), additions: additions ?? Number.NaN, deletions: deletions ?? Number.NaN }));
  return changedLineCount(changed, { generated: DEFAULT_CLASS_RULES.generated, largeLines: limit });
}

/** True when the PR changes a lockfile or package.json, which takes g10 whatever its size. */
export function prTouchesDependency(files: readonly PrFile[]): boolean {
  return touchesDependency(files);
}

/** True when the PR changes a store migration, a rename's old path included, which takes g10 whatever its size. */
export function prTouchesMigration(files: readonly PrFile[]): boolean {
  return pathTouches(files, MIGRATION_RULES).includes("migration");
}

/** A class the config leaves out, or a config with no table, keeps the one `profile` it had before the table. */
export function configuredRoles(review: { profile: string; roles?: Partial<ClassRoles>; g10ChangedLines?: number }): ReviewerRoles {
  const limit = review.g10ChangedLines;
  return { g10: review.roles?.g10 ?? review.profile, standard: review.roles?.standard ?? review.profile, ...(limit !== undefined && { g10ChangedLines: limit }) };
}
