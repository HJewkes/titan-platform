import { describe, expect, it } from "vitest";
import { relativeImports } from "../test-support/relative-imports.js";

describe("shepherd policy-schema leaf", () => {
  it("imports only plan-approval.ts, never policy.ts's workflow code", () => {
    expect(relativeImports("shepherd/policy-schema.ts")).toEqual(["./plan-approval.js"]);
  });

  it("store.ts reads its policy types from the leaf, not policy.ts", () => {
    expect(relativeImports("shepherd/store.ts")).not.toContain("./policy.js");
  });
});
