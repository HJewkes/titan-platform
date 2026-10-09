import { describe, expect, it } from "vitest";
import { configuredRoles, DEFAULT_REVIEWER_ROLES, prChangedLines, reviewerClassFor, reviewerRoleFor } from "./reviewer-roles.js";

describe("reviewerRoleFor", () => {
  it("gives a security PR and a small correctness PR different profiles", () => {
    const security = reviewerRoleFor({ kind: "security", changedLines: 30 });
    const correctness = reviewerRoleFor({ kind: "correctness", changedLines: 30 });

    expect(security).toBe(DEFAULT_REVIEWER_ROLES.g10);
    expect(correctness).toBe(DEFAULT_REVIEWER_ROLES.standard);
    expect(security).not.toBe(correctness);
  });

  it("puts a PR of unknown kind and size in the standard class", () => {
    expect(reviewerClassFor({})).toBe("standard");
  });

  it("puts a PR whose kind could not be read in the g10 class", () => {
    expect(reviewerClassFor({ unread: true })).toBe("g10");
  });

  it("uses the table it is given", () => {
    expect(reviewerRoleFor({ kind: "security" }, { g10: "a", standard: "b" })).toBe("a");
  });

  it("gives a correctness PR of 399 changed lines the standard profile and one of 401 the g10 profile", () => {
    expect(reviewerRoleFor({ kind: "correctness", changedLines: 399 })).toBe(DEFAULT_REVIEWER_ROLES.standard);
    expect(reviewerRoleFor({ kind: "correctness", changedLines: 401 })).toBe(DEFAULT_REVIEWER_ROLES.g10);
  });

  it("takes the changed-line limit from the table when it names one", () => {
    expect(reviewerRoleFor({ kind: "correctness", changedLines: 101 }, { g10: "a", standard: "b", g10ChangedLines: 100 })).toBe("a");
    expect(reviewerRoleFor({ kind: "correctness", changedLines: 401 }, { g10: "a", standard: "b", g10ChangedLines: 1_000 })).toBe("b");
  });
});

describe("prChangedLines", () => {
  it("counts additions plus deletions and leaves generated registry files out", () => {
    const files = [{ path: "products/factory/src/a.ts", status: "modified", additions: 30, deletions: 10 }, { path: "CAPABILITIES.md", status: "modified", additions: 300, deletions: 61 }];

    expect(prChangedLines(files)).toBe(40);
    expect(reviewerClassFor({ kind: "correctness", changedLines: prChangedLines(files) })).toBe("standard");
  });

  it("is unknown when a counted file carries no line counts", () => {
    expect(prChangedLines([{ path: "a.ts", status: "modified" }])).toBeUndefined();
  });
});

describe("configuredRoles", () => {
  it("keeps review.profile for every class when the config has no roles", () => {
    expect(configuredRoles({ profile: "rv" })).toEqual({ g10: "rv", standard: "rv" });
  });

  it("falls back to review.profile for a class the table leaves out", () => {
    expect(configuredRoles({ profile: "rv", roles: { g10: "bd-reviewer" } })).toEqual({ g10: "bd-reviewer", standard: "rv" });
  });

  it("carries a configured changed-line limit", () => {
    expect(configuredRoles({ profile: "rv", g10ChangedLines: 250 })).toEqual({ g10: "rv", standard: "rv", g10ChangedLines: 250 });
  });
});
