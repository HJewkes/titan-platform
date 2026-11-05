import { describe, expect, it } from "vitest";
import { parseStoredPolicy, PolicyNewerThanBuild, type EffectivePolicy } from "./policy-schema.js";
import { runPolicyCeiling } from "./policy.js";
import { relativeImports } from "../test-support/relative-imports.js";

describe("shepherd policy-schema leaf", () => {
  it("imports only plan-approval.ts, never policy.ts's workflow code", () => {
    expect(relativeImports("shepherd/policy-schema.ts")).toEqual(["./plan-approval.js"]);
  });

  it("store.ts reads its policy types from the leaf, not policy.ts", () => {
    expect(relativeImports("shepherd/store.ts")).not.toContain("./policy.js");
  });
});

const KNOWN: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: true, seat: "trusted-seat" };

describe("a stored policy carrying a key this build lacks", () => {
  const stored = (extra: object) => JSON.stringify({ ...KNOWN, ...extra });

  it("fails a stored policy read as PolicyNewerThanBuild naming the key and the deploy fix", () => {
    const read = () => parseStoredPolicy(stored({ futureGrant: "yes" }));

    expect(read).toThrow(PolicyNewerThanBuild);
    expect(read).toThrow(/"futureGrant".*deploy current main/);
  });

  it("fails a run param ceiling the same way", () => {
    expect(() => runPolicyCeiling(stored({ futureGrant: "yes" }))).toThrow(PolicyNewerThanBuild);
  });

  it("names an unknown key nested in the visual baselines by its path", () => {
    const read = () => parseStoredPolicy(stored({ visualBaselines: { check: "shots", paths: [], threshold: 1 } }));

    expect(read).toThrow(/"visualBaselines\.threshold"/);
  });

  it("keeps refusing a stored approved key as an ordinary parse error", () => {
    const read = () => parseStoredPolicy(stored({ approved: [] }));

    expect(read).toThrow();
    expect(read).not.toThrow(PolicyNewerThanBuild);
  });

  it("reads a policy whose keys this build knows", () => {
    expect(parseStoredPolicy(stored({}))).toEqual(KNOWN);
  });
});
