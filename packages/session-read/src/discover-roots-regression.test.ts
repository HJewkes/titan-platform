import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeTranscriptRoots } from "./discover.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "titan-discover-regress-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("claudeTranscriptRoots profile discovery", () => {
  it("lists the default root when ~/.claude does not exist", () => {
    const roots = claudeTranscriptRoots({});

    expect(roots).toEqual([{ root: path.join(home, ".claude", "projects"), account: "default" }]);
  });

  it("skips a symlinked ~/.claude-profiles root", () => {
    const elsewhere = path.join(home, "elsewhere");
    mkdirSync(path.join(elsewhere, "other", "projects"), { recursive: true });
    symlinkSync(elsewhere, path.join(home, ".claude-profiles"));

    const roots = claudeTranscriptRoots({});

    expect(roots.map((r) => r.account)).toEqual(["default"]);
  });

  it("labels a dotted CLAUDE_CONFIG_DIRS entry without the dot", () => {
    const dotted = path.join(home, "elsewhere", ".work");

    const roots = claudeTranscriptRoots({ CLAUDE_CONFIG_DIRS: dotted });

    expect(roots).toEqual([{ root: path.join(dotted, "projects"), account: "work" }]);
  });

  it('labels an override entry that is only dots "default"', () => {
    const roots = claudeTranscriptRoots({ CLAUDE_CONFIG_DIRS: `${home}/..` });

    expect(roots.map((r) => r.account)).toEqual(["default"]);
  });
});
