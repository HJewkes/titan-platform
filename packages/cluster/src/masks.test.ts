import { describe, expect, it } from "vitest";
import { applyMasks } from "./masks.js";

describe("generic SHA mask", () => {
  it("resolves a long run of decimal digits to NUM", () => {
    const { maskedSignature, extractedParams } = applyMasks("generic", "ts 1696300000 done");

    expect(maskedSignature).toBe("ts <NUM> done");
    expect(extractedParams).toEqual({ NUM: "1696300000" });
  });

  it("leaves an all-letter hex word unmasked", () => {
    const { maskedSignature } = applyMasks("generic", "defaced effaced");

    expect(maskedSignature).toBe("defaced effaced");
  });

  it("resolves a 7-character git sha to SHA", () => {
    const { maskedSignature, extractedParams } = applyMasks("generic", "commit 1a2b3c4 landed");

    expect(maskedSignature).toBe("commit <SHA> landed");
    expect(extractedParams).toEqual({ SHA: "1a2b3c4" });
  });
});
