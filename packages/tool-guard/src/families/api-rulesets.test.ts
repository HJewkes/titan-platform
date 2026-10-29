import { describe, expect, it } from "vitest";
import { apiSettingsWrite } from "./api-rulesets.js";

const WRITES = ["POST", "PUT", "PATCH", "DELETE", "post", null];

const ROUTES = [
  ["repos/o/r/rulesets", { route: "rulesets", scope: "repo" }],
  ["repos/o/r/rulesets/42", { route: "rulesets", scope: "repo" }],
  ["repositories/123/rulesets/42", { route: "rulesets", scope: "repository-id" }],
  ["orgs/o/rulesets", { route: "rulesets", scope: "org" }],
  ["orgs/o/rulesets/7", { route: "rulesets", scope: "org" }],
  ["enterprises/e/rulesets/7", { route: "rulesets", scope: "enterprise" }],
  ["repos/o/r/branches/main/protection", { route: "branch-protection", scope: "repo" }],
  ["repositories/123/branches/main/protection/enforce_admins", { route: "branch-protection", scope: "repository-id" }],
] as const;

describe("apiSettingsWrite, a write to a ruleset or branch-protection route", () => {
  it.each(ROUTES.flatMap(([path, want]) => WRITES.map((method) => [path, method, want] as const)))("reads %s with %s", (path, method, want) => {
    expect(apiSettingsWrite(path, method)).toEqual(want);
  });

  it.each([
    ["https://api.github.com/repos/o/r/rulesets/1", { route: "rulesets", scope: "repo" }],
    ["https://ghes.example.ts.net/api/v3/orgs/o/rulesets", { route: "rulesets", scope: "org" }],
    ["/repos/o/r/rulesets/1?per_page=1", { route: "rulesets", scope: "repo" }],
    ["repos/o/r//rulesets/1", { route: "rulesets", scope: "repo" }],
    ["REPOS/o/r/RuleSets/1", { route: "rulesets", scope: "repo" }],
    ["repos/o/r/rule%73ets/1", { route: "rulesets", scope: "repo" }],
    ["repos/o/r/branches/release/2.0/protection/enforce_admins", { route: "branch-protection", scope: "repo" }],
    ["repos/o/r/branches/feat/x/protection/required_status_checks/contexts", { route: "branch-protection", scope: "repo" }],
    ["repos/{owner}/{repo}/rulesets/1", { route: "rulesets", scope: "repo" }],
    ["repos/:owner/:repo/branches/main/protection", { route: "branch-protection", scope: "repo" }],
  ] as const)("reads the written path %s", (url, want) => {
    expect(apiSettingsWrite(url, "PUT")).toEqual(want);
  });

  it.each([
    ["repos/o/r/x/../rulesets", "rulesets"],
    ["repos/o/r/%2e%2e/rulesets/1", "rulesets"],
    ["repos/o/r/rulesets/%E0", "rulesets"],
    ["repos/o/r/branches/main/./protection", "branch-protection"],
    ["repos/o/r/{branch}", "branch-protection"],
    ["{branch}/rulesets", "rulesets"],
  ])("reads the unsure path %s as an unknown %s write", (url, route) => {
    expect(apiSettingsWrite(url, "DELETE")).toEqual({ route, scope: "unknown" });
  });
});

describe("apiSettingsWrite, a request that changes no ruleset or protection", () => {
  it.each(ROUTES.flatMap(([path]) => ["GET", "HEAD", "get"].map((method) => [path, method] as const)))("passes %s with %s", (path, method) => {
    expect(apiSettingsWrite(path, method)).toBeNull();
  });

  it.each([
    "repos/o/r/rulesetsx",
    "repos/o/r/rulesets-foo",
    "repos/o/r/branches/main",
    "repos/o/r/branches/main/protectionx",
    "repos/o/r/issues",
    "repos/o/r/x/../issues",
    "repos/o/r/contents/%E0",
    "orgs/o/rulesetsx/1",
    "repos/{owner}/{repo}/issues",
  ])("passes a write to %s", (url) => {
    expect(apiSettingsWrite(url, "POST")).toBeNull();
  });
});
