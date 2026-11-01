import { describe, expect, it } from "vitest";
import { relativeImports } from "../test-support/relative-imports.js";

const ALLOWED = ["./auto-pass.js", "./ci-timeout-entry.js", "./none-reason.js", "./policy-schema.js","./stage-times.js", "./step-phase.js"];

describe("shepherd view-schema leaf", () => {
  it("imports only the schema pieces its fields name, never view.ts or wake.ts", () => {
    expect(relativeImports("shepherd/view-schema.ts").sort()).toEqual(ALLOWED);
  });

  it("waiting-schema.ts imports nothing in factory", () => {
    expect(relativeImports("shepherd/waiting-schema.ts")).toEqual([]);
  });
});
