import { describe, expect, it } from "vitest";
import { EXTRACT_VERSION } from "./audit-events.js";

describe("EXTRACT_VERSION", () => {
  it("is 7 so graphs indexed with a subshell closer in a branch name re-extract", () => {
    expect(EXTRACT_VERSION).toBe(7);
  });
});
