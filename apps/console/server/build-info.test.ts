import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildInfoOf, readBuildInfo, stampBuildInfo } from "./build-info.js";

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

  describe("stamping", () => {
    const now = new Date("2031-03-05T09:41:12.000Z");
    const fileIn = () => path.join(mkdtempSync(path.join(tmpdir(), "console-stamp-")), "build-info.json");

    it("writes the head and dirtiness git reports", () => {
      const file = fileIn();
      const git = (args: string[]) => (args[0] === "rev-parse" ? `${SHA}\n` : "");

      stampBuildInfo(git, file, now, () => {});

      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ sha: SHA, builtAt: now.toISOString(), dirty: false });
    });

    it("leaves the build unstamped and warns, without throwing, when git fails", () => {
      const file = fileIn();
      const warnings: string[] = [];
      const git = () => {
        throw new Error("fatal: detected dubious ownership in repository");
      };

      const info = stampBuildInfo(git, file, now, (message) => warnings.push(message));

      expect([info, existsSync(file), readBuildInfo(file)]).toEqual([null, false, null]);
      expect(warnings).toEqual(["build not stamped: fatal: detected dubious ownership in repository"]);
    });

    it("removes the stamp of an earlier build when git fails, so the footer never shows a stale commit", () => {
      const file = fileIn();
      writeFileSync(file, JSON.stringify({ sha: SHA, builtAt: now.toISOString(), dirty: false }));

      stampBuildInfo(() => {
        throw new Error("not a git repository");
      }, file, now, () => {});

      expect(readBuildInfo(file)).toBeNull();
    });
  });
});
