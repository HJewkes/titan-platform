import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSha, UNKNOWN_BUILD_SHA } from "./build-info.js";

afterEach(() => vi.unstubAllGlobals());

describe("buildSha", () => {
  it("reads unknown when no build baked a sha in", () => {
    expect(buildSha()).toBe(UNKNOWN_BUILD_SHA);
  });

  it("reads the baked sha, dirty suffix included", () => {
    vi.stubGlobal("__FACTORY_BUILD_SHA__", "abc123-dirty");

    expect(buildSha()).toBe("abc123-dirty");
  });

  it("reads unknown when the baked sha is empty", () => {
    vi.stubGlobal("__FACTORY_BUILD_SHA__", "");

    expect(buildSha()).toBe(UNKNOWN_BUILD_SHA);
  });
});
