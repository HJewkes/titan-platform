import { describe, expect, it } from "vitest";
import { digestDirectories } from "./sources.js";

describe("digestDirectories", () => {
  it("maps a legacy icloudDir-only config into the copy list", () => {
    const dirs = digestDirectories({ digest: { outDir: "/out", icloudDir: "/icloud" } }, {});

    expect(dirs).toEqual({ outDir: "/out", copyDirs: ["/icloud"] });
  });

  it("unions copyDirs with icloudDir and drops duplicates", () => {
    const dirs = digestDirectories({ digest: { copyDirs: ["/a", "/icloud", "/a"], icloudDir: "/icloud" } }, { XDG_STATE_HOME: "/state" });

    expect(dirs.copyDirs).toEqual(["/a", "/icloud"]);
  });

  it("has no copy dirs when none are configured", () => {
    expect(digestDirectories({}, { XDG_STATE_HOME: "/state" }).copyDirs).toEqual([]);
  });
});
