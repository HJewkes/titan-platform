import { describe, expect, it } from "vitest";
import { planCommands } from "./verify-changed.mjs";

describe("planCommands sidecar kills step", () => {
  const workspace = [{ dir: "packages/a/", name: "a", deps: [] }];

  it("audits sidecar kills against the base", () => {
    const plan = planCommands({ base: "origin/main", changed: ["packages/a/src/x.ts"], workspace, hasTimeout: true });

    expect(plan.find((c) => c.label === "sidecar:kills").args).toEqual(["run", "sidecar:kills", "--base", "origin/main"]);
  });
});
