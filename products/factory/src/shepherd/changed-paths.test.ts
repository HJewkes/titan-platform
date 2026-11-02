import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isCarryFencedPath } from "@titan-design/authority";
import { gitIn, seedRepo } from "@titan-design/test-kit/git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedPathsBetween } from "./changed-paths.js";
import { CarryRefusal, systemGit } from "./tree-carry.js";


let root: string;
let repo: string;

function git(...args: string[]): string {
  return gitIn(repo)(...args);
}

function commit(file: string, text: string): string {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
  git("add", file);
  git("commit", "-q", "-m", `edit ${file}`);
  return git("rev-parse", "HEAD");
}

function rename(from: string, to: string): string {
  mkdirSync(dirname(join(repo, to)), { recursive: true });
  git("mv", from, to);
  git("commit", "-q", "-m", `move ${from}`);
  return git("rev-parse", "HEAD");
}

const listed = (from: string, to: string): Promise<string[]> => changedPathsBetween(systemGit, join(repo, ".git"), from, to);
const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "changed-paths-"));
  repo = join(root, "repo");
  seedRepo(repo, {});
  git("config", "diff.renames", "true");
  commit("README.md", "seed\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("changedPathsBetween", { timeout: 30_000 }, () => {
  it("lists both sides of a rename out of .github/workflows/, so the fenced old path meets the fence", async () => {
    const before = commit(".github/workflows/old.yml", body);
    const after = rename(".github/workflows/old.yml", "docs/old.yml");

    const paths = await listed(before, after);

    expect(paths.sort()).toEqual([".github/workflows/old.yml", "docs/old.yml"]);
    expect(isCarryFencedPath(".github/workflows/old.yml")).toBe(true);
    expect(paths.some(isCarryFencedPath)).toBe(true);
  });

  it("lists both sides of a rename into .github/workflows/, keeping the unfenced old path", async () => {
    const before = commit("docs/new.yml", body);
    const after = rename("docs/new.yml", ".github/workflows/new.yml");

    const paths = await listed(before, after);

    expect(paths.sort()).toEqual([".github/workflows/new.yml", "docs/new.yml"]);
    expect(paths.filter(isCarryFencedPath)).toEqual([".github/workflows/new.yml"]);
  });

  it("keeps a path's leading space byte-exact", async () => {
    const before = git("rev-parse", "HEAD");
    const after = commit(" notes.txt", "spaced\n");

    expect(await listed(before, after)).toEqual([" notes.txt"]);
  });

  it("refuses an unknown revision instead of answering no change", async () => {
    const before = git("rev-parse", "HEAD");

    await expect(listed(before, "0".repeat(40))).rejects.toBeInstanceOf(CarryRefusal);
  });
});
