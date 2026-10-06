import { describe, expect, it } from "vitest";
import { EXTRACT_VERSION } from "./audit-events.js";

describe("EXTRACT_VERSION", () => {
  it("is 6 so graphs indexed with git intents read from quoted text re-extract", () => {
    expect(EXTRACT_VERSION).toBe(6);
  });
});
