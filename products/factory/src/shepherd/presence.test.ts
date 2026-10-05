import { describe, expect, it } from "vitest";
import { toPresence } from "./presence.js";

describe("toPresence", () => {
  it.each(["live", "detached", "exiting", "exited", "deregistered"])("keeps the known value %s", (value) => {
    expect(toPresence(value)).toBe(value);
  });

  it("turns a value the roster should not report into unknown, not live", () => {
    expect(toPresence("suspended")).toBe("unknown");
  });
});
