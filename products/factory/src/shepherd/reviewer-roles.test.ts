import { describe, expect, it } from "vitest";
import { configuredRoles, DEFAULT_REVIEWER_ROLES, reviewerClassFor, reviewerRoleFor } from "./reviewer-roles.js";

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
});

describe("configuredRoles", () => {
  it("keeps review.profile for every class when the config has no roles", () => {
    expect(configuredRoles({ profile: "rv" })).toEqual({ g10: "rv", standard: "rv" });
  });

  it("falls back to review.profile for a class the table leaves out", () => {
    expect(configuredRoles({ profile: "rv", roles: { g10: "bd-reviewer" } })).toEqual({ g10: "bd-reviewer", standard: "rv" });
  });
});
