import { describe, expect, it } from "vitest";
import { parseFixProofConfig } from "./config.js";

describe("parseFixProofConfig runtime", () => {
  it("parses runtime globs", () => {
    const result = parseFixProofConfig(JSON.stringify({ runtime: ["pkg/fixtures/**"] }));

    expect(result.ok && result.config.runtime).toEqual(["pkg/fixtures/**"]);
  });

  it("defaults runtime to empty", () => {
    const result = parseFixProofConfig(JSON.stringify({ carry: ["**/fixtures/**"] }));

    expect(result.ok && result.config.runtime).toEqual([]);
  });

  it("refuses a non-array runtime", () => {
    const result = parseFixProofConfig(JSON.stringify({ runtime: "x" }));

    expect(result).toEqual({ ok: false, error: ".github/fix-proof.json: runtime must be an array of non-empty strings" });
  });
});
