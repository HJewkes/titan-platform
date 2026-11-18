import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSync = vi.hoisted(() => vi.fn(() => "abc123\n"));
vi.mock("node:child_process", () => ({ execFileSync }));

import { realDeps } from "./cli.js";

describe("realDeps", () => {
  beforeEach(() => execFileSync.mockClear());

  it("pipes stderr for merge-base so a failure prints only the skip warning", () => {
    const sha = realDeps().mergeBase("main");

    expect(sha).toBe("abc123");
    expect(execFileSync).toHaveBeenCalledWith("git", ["merge-base", "main", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
});
