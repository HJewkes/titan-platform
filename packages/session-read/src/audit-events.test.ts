import { describe, expect, it } from "vitest";
import { EXTRACT_VERSION } from "./audit-events.js";

describe("EXTRACT_VERSION", () => {
  it("is 4 so graphs indexed with the stray-paren command heads re-extract", () => {
    expect(EXTRACT_VERSION).toBe(4);
  });
});
