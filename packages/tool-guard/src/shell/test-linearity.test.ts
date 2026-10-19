import { describe, expect, it } from "vitest";
import { LINEARITY_TIMEOUT_MS } from "./test-linearity.js";

describe("the time a linearity check may take", () => {
  it("outlasts the 5 s default a loaded CI worker overran", () => {
    expect(typeof LINEARITY_TIMEOUT_MS).toBe("number");
    expect(LINEARITY_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});
