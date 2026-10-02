import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSha, FACTORY_REPO, repoSlugOf, UNKNOWN_BUILD_SHA } from "./build-info.js";

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

describe("repoSlugOf", () => {
  it("reads owner/name from a git+https url with a .git suffix", () => {
    expect(repoSlugOf("git+https://github.com/octo/demo.git")).toBe("octo/demo");
  });

  it("reads owner/name from an ssh url", () => {
    expect(repoSlugOf("git@github.com:octo/demo.git")).toBe("octo/demo");
  });

  it("reads nothing from a url that merely contains a github slug", () => {
    expect(repoSlugOf("https://evil.example/github.com/octo/demo.git")).toBeUndefined();
    expect(repoSlugOf("https://notgithub.com/octo/demo.git")).toBeUndefined();
  });

  it("reads nothing from a url on another host", () => {
    expect(repoSlugOf("https://gitlab.com/octo/demo.git")).toBeUndefined();
  });

  it("reads the factory's own repo from its package.json", () => {
    expect(FACTORY_REPO).toMatch(/^[^/]+\/titan-platform$/);
  });
});
