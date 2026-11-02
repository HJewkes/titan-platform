// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { unmountPages } from "./render-page.test-helpers.js";

describe("unmountPages", () => {
  it("waits for the immediate queue the scheduler uses, not only for a timeout", async () => {
    const queueImmediate = vi.spyOn(globalThis, "setImmediate");

    await unmountPages();

    expect(queueImmediate).toHaveBeenCalled();
    queueImmediate.mockRestore();
  });
});
