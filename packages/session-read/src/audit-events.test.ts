import { describe, expect, it } from "vitest";
import { EXTRACT_VERSION } from "./audit-events.js";

describe("EXTRACT_VERSION", () => {
  it("is 9 so graphs indexed before the context_block emit policy re-extract their audit facet", () => {
    expect(EXTRACT_VERSION).toBe(9);
  });
});
