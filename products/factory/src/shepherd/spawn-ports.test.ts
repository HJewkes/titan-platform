import { describe, expect, it } from "vitest";
import { relativeImports } from "../test-support/relative-imports.js";

describe("shepherd spawn-ports leaf", () => {
  it("imports only agents.ts, so the phases hub never reaches the spawn steps through it", () => {
    expect(relativeImports("shepherd/spawn-ports.ts")).toEqual(["./agents.js"]);
  });

  it("phases.ts reads the spawn ports from the leaf, not the steps that use them", () => {
    const imports = relativeImports("shepherd/phases.ts");

    expect(imports).toContain("./spawn-ports.js");
    expect(imports).not.toContain("./visual-packet-trigger.js");
    expect(imports).not.toContain("./no-verdict-diagnosis.js");
  });
});
