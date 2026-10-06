import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeTranscriptRoots, discoverAllTranscripts, discoverTranscripts } from "./discover.js";

let home: string;
let originalHome: string | undefined;
let locked: string[];

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "titan-discover-roots-"));
  originalHome = process.env.HOME;
  process.env.HOME = home;
  locked = [];
});

afterEach(() => {
  process.env.HOME = originalHome;
  for (const lockedPath of locked) chmodSync(lockedPath, 0o700);
  rmSync(home, { recursive: true, force: true });
});

function lock(target: string): void {
  chmodSync(target, 0o000);
  locked.push(target);
}

function makeProjectsDir(configDir: string): void {
  mkdirSync(path.join(configDir, "projects"), { recursive: true });
}

describe("claudeTranscriptRoots", () => {
  it("lists ~/.claude and each profile that has a projects dir", () => {
    makeProjectsDir(path.join(home, ".claude"));
    makeProjectsDir(path.join(home, ".claude-profiles", "work"));
    makeProjectsDir(path.join(home, ".claude-profiles", "research"));

    const roots = claudeTranscriptRoots();

    expect(roots.map((r) => r.account).sort()).toEqual(["default", "research", "work"]);
  });

  it("skips a profile with no projects dir", () => {
    makeProjectsDir(path.join(home, ".claude"));
    mkdirSync(path.join(home, ".claude-profiles", "personal"), { recursive: true });

    const roots = claudeTranscriptRoots();

    expect(roots.map((r) => r.account)).toEqual(["default"]);
  });

  it('labels the default root "default" and a profile by its directory name', () => {
    makeProjectsDir(path.join(home, ".claude"));
    makeProjectsDir(path.join(home, ".claude-profiles", "acme"));

    const roots = claudeTranscriptRoots();

    expect(roots).toContainEqual({ root: path.join(home, ".claude", "projects"), account: "default" });
    expect(roots).toContainEqual({
      root: path.join(home, ".claude-profiles", "acme", "projects"),
      account: "acme",
    });
  });

  it("CLAUDE_CONFIG_DIRS overrides discovery", () => {
    makeProjectsDir(path.join(home, ".claude"));
    const overrideDir = path.join(home, "elsewhere", "custom-account");
    makeProjectsDir(overrideDir);

    const roots = claudeTranscriptRoots({ CLAUDE_CONFIG_DIRS: overrideDir });

    expect(roots).toEqual([{ root: path.join(overrideDir, "projects"), account: "custom-account" }]);
  });
});

describe("discoverAllTranscripts", () => {
  it("returns a stable order and sets account", async () => {
    const defaultRoot = path.join(home, ".claude", "projects", "proj-a");
    mkdirSync(defaultRoot, { recursive: true });
    writeFileSync(path.join(defaultRoot, "session-1.jsonl"), "");

    const profileRoot = path.join(home, ".claude-profiles", "work", "projects", "proj-b");
    mkdirSync(profileRoot, { recursive: true });
    writeFileSync(path.join(profileRoot, "session-2.jsonl"), "");

    const first = await discoverAllTranscripts();
    const second = await discoverAllTranscripts();

    expect(first).toEqual(second);
    expect(first.map((t) => t.account).sort()).toEqual(["default", "work"]);
  });
});

describe("discoverTranscripts", () => {
  it("still returns account null", async () => {
    const projectDir = path.join(home, ".claude", "projects", "proj-a");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, "session-1.jsonl"), "");

    const found = await discoverTranscripts(path.join(home, ".claude", "projects"));

    expect(found).toHaveLength(1);
    expect(found[0]?.account).toBeNull();
  });

  it("returns no transcripts when the projects dir is missing", async () => {
    await expect(discoverTranscripts(path.join(home, ".claude", "projects"))).resolves.toEqual([]);
  });

  it("skips a stray file beside the project directories", async () => {
    const root = path.join(home, ".claude", "projects");
    mkdirSync(path.join(root, "proj-a"), { recursive: true });
    writeFileSync(path.join(root, "proj-a", "session-1.jsonl"), "");
    writeFileSync(path.join(root, ".DS_Store"), "");

    const found = await discoverTranscripts(root);

    expect(found.map((t) => t.projectDir)).toEqual(["proj-a"]);
  });

  it.skipIf(process.getuid?.() === 0)("rejects instead of returning no transcripts when a project dir is unreadable", async () => {
    const projectDir = path.join(home, ".claude", "projects", "proj-a");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, "session-1.jsonl"), "");
    lock(projectDir);

    await expect(discoverTranscripts(path.join(home, ".claude", "projects"))).rejects.toMatchObject({ code: "EACCES" });
  });
});
