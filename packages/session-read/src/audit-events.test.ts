import { describe, expect, it } from "vitest";
import { EXTRACT_VERSION } from "./audit-events.js";

describe("EXTRACT_VERSION", () => {
  it("is 8 so graphs indexed before inbound kept the channel broadcast flag re-extract", () => {
    expect(EXTRACT_VERSION).toBe(8);
  });
});
