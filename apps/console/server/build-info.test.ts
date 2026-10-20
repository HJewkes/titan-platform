import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildInfoOf, readBuildInfo } from "./build-info.js";

const SHA = "3f9a1c0b7e2d4a6f8b1c3e5d7f9a0b2c4d6e8f10";

describe("build info", () => {
  it("stamps the head, the time and whether tracked files had changes", () => {
    const now = new Date("2031-03-05T09:41:12.000Z");
    expect(buildInfoOf({ head: `${SHA}\n`, status: "" }, now)).toEqual({ sha: SHA, builtAt: "2031-03-05T09:41:12.000Z", dirty: false });
    expect(buildInfoOf({ head: SHA, status: " M apps/console/src/App.tsx\n" }, now).dirty).toBe(true);
  });

  it("reads a stamped file and answers null for a missing or malformed one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "console-build-info-"));
    const file = path.join(dir, "build-info.json");
    expect(readBuildInfo(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ sha: "not-a-sha", builtAt: "x", dirty: false }));
    expect(readBuildInfo(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ sha: SHA, builtAt: "2031-03-05T09:41:12.000Z", dirty: false }));
    expect(readBuildInfo(file)?.sha).toBe(SHA);
  });
});
