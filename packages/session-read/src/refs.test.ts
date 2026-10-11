import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fileRef, parseFileRef, toRepoRelative } from "./refs.js";
import { clearRepoCache } from "./repo-root.js";

let dir: string;
let main: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "session-read-refs-"));
  main = path.join(dir, "demo");
  mkdirSync(path.join(main, ".git"), { recursive: true });
  writeFileSync(path.join(main, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/demo.git\n');
  clearRepoCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearRepoCache();
});

/** A linked worktree under the main checkout, as `git worktree add .worktrees/<name>` leaves it. */
function addWorktree(name: string): string {
  const gitDir = path.join(main, ".git", "worktrees", name);
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(path.join(gitDir, "commondir"), "../..\n");
  const worktree = path.join(main, ".worktrees", name);
  mkdirSync(worktree, { recursive: true });
  writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  return worktree;
}

describe("toRepoRelative across worktrees", () => {
  it("resolves a file in a live worktree relative to the worktree root", () => {
    const worktree = addWorktree("feature-a");

    expect(toRepoRelative(path.join(worktree, "packages", "core", "src", "index.ts"))).toEqual({
      repo: "demo",
      path: "packages/core/src/index.ts",
    });
  });

  it("strips the worktree prefix once the worktree has been removed", () => {
    const gone = path.join(main, ".worktrees", "feature-b", "scripts", "build.mjs");

    expect(toRepoRelative(gone)).toEqual({ repo: "demo", path: "scripts/build.mjs" });
  });

  it("gives a live and a removed worktree's copy of a file the same ref", () => {
    const live = toRepoRelative(path.join(addWorktree("feature-a"), "src", "app.ts"));
    const removed = toRepoRelative(path.join(main, ".worktrees", "feature-b", "src", "app.ts"));
    const onMain = toRepoRelative(path.join(main, "src", "app.ts"));

    expect(fileRef(live.repo, live.path)).toBe("file:demo/src/app.ts");
    expect(fileRef(removed.repo, removed.path)).toBe("file:demo/src/app.ts");
    expect(fileRef(onMain.repo, onMain.path)).toBe("file:demo/src/app.ts");
  });

  it("keeps a file directly under .worktrees, which names no worktree", () => {
    expect(toRepoRelative(path.join(main, ".worktrees", "README.md"))).toEqual({
      repo: "demo",
      path: ".worktrees/README.md",
    });
  });

  it("leaves a path outside any repo absolute and unattributed, even under a .worktrees directory", () => {
    const outside = path.join(dir, "scratch", ".worktrees", "old", "notes.md");

    expect(toRepoRelative(outside)).toEqual({ repo: null, path: outside });
  });
});

describe("parseFileRef", () => {
  it("splits a repo ref at the first slash", () => {
    expect(parseFileRef("file:demo/packages/core/src/index.ts")).toEqual({
      repo: "demo",
      path: "packages/core/src/index.ts",
    });
  });

  it("strips a worktree prefix leaked into a stored ref", () => {
    expect(parseFileRef("file:demo/.worktrees/feature-b/scripts/build.mjs")).toEqual({
      repo: "demo",
      path: "scripts/build.mjs",
    });
  });

  it("returns a null repo for a ref stored without one, so it renders as plain text", () => {
    expect(parseFileRef("file:/srv/state/notes.md")).toEqual({ repo: null, path: "/srv/state/notes.md" });
    expect(parseFileRef("file:notes.md")).toEqual({ repo: null, path: "notes.md" });
  });

  it("returns null for a ref that is not a file ref", () => {
    expect(parseFileRef("pr:demo#12")).toBeNull();
    expect(parseFileRef("src/app.ts")).toBeNull();
  });

  it("round-trips what fileRef writes", () => {
    expect(parseFileRef(fileRef("demo", "src/app.ts"))).toEqual({ repo: "demo", path: "src/app.ts" });
    expect(parseFileRef(fileRef(null, "/srv/app.ts"))).toEqual({ repo: null, path: "/srv/app.ts" });
  });
});
