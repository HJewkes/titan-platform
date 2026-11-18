import { DEFAULT_CLASS_RULES } from "@titan-design/review-panel";
import { describe, expect, it } from "vitest";
import { HOLD_COMMAND_FILES, MERGE_POLICY_FILES, OWNER_ACTION_FILES, POLICY_TABLES, SHEPHERD_CLASS_RULES, SHEPHERD_LISTED_RULES, policyTablesOf } from "./g10-class-rules.js";

describe("the named policy tables (TP-5403)", () => {
  it("the policy table rebuilt from POLICY_TABLES equals the listed globs", () => {
    const { "hold-closure": closure, ...listed } = POLICY_TABLES;
    const leading = [...DEFAULT_CLASS_RULES.policy, ...MERGE_POLICY_FILES, ...HOLD_COMMAND_FILES, ...OWNER_ACTION_FILES];

    expect(SHEPHERD_LISTED_RULES.policy).toEqual(Object.values(listed).flat());
    expect(SHEPHERD_CLASS_RULES.policy).toEqual([...SHEPHERD_LISTED_RULES.policy, ...closure]);
    expect(SHEPHERD_LISTED_RULES.policy.slice(0, leading.length)).toEqual(leading);
  });

  it("names the tables each policy path matches, a rename's old path included", () => {
    const tables = policyTablesOf([{ path: "packages/store/src/a.ts", previousPath: "products/factory/src/shepherd/wake-loop.ts" }]);

    expect([...tables]).toEqual([["products/factory/src/shepherd/wake-loop.ts", ["hold-closure"]]]);
  });

  it("leaves a test of a policy file out, as the panel's test exemption does", () => {
    expect(policyTablesOf([{ path: "products/factory/src/shepherd/wake-loop.test.ts" }]).size).toBe(0);
  });

  it("counts a held check's test file in its table despite the test exemption", () => {
    const path = "products/factory/src/shepherd/hold-table-coverage.test.ts";

    expect(policyTablesOf([{ path }]).get(path)).toEqual(["hold-closure-check"]);
  });
});
