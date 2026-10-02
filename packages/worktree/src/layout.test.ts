import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyClaudeDir } from "./layout.js";

const tmpdirs: string[] = [];

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const tmp = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-dir-")));
  tmpdirs.push(dir);
  return dir;
};

/** A main checkout with a real .claude, and a separate tree and outside area. */
function scene() {
  const root = tmp();
  const gitRoot = path.join(root, "main");
  const tree = path.join(root, "tree");
  const outside = path.join(root, "outside");
  for (const dir of [gitRoot, tree, outside]) fs.mkdirSync(dir);
  fs.mkdirSync(path.join(gitRoot, ".claude"));
  fs.writeFileSync(path.join(gitRoot, ".claude", "settings.json"), "{}");
  return { gitRoot, tree, outside, target: path.join(tree, ".claude") };
}

describe("copyClaudeDir", () => {
  it("copies .claude into a tree that has none", () => {
    const { gitRoot, tree, target } = scene();
    expect(copyClaudeDir(gitRoot, tree)).toEqual([]);
    expect(fs.readFileSync(path.join(target, "settings.json"), "utf8")).toBe("{}");
  });

  it("writes nothing outside the tree when the branch committed a dangling .claude symlink", () => {
    const { gitRoot, tree, outside, target } = scene();
    const escape = path.join(outside, "not-yet");
    fs.symlinkSync(escape, target);

    const warnings = copyClaudeDir(gitRoot, tree);

    expect(fs.existsSync(escape)).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("a symlink");
  });

  it("writes nothing into the directory a .claude symlink points at", () => {
    const { gitRoot, tree, outside, target } = scene();
    fs.symlinkSync(outside, target);

    const warnings = copyClaudeDir(gitRoot, tree);

    expect(fs.readdirSync(outside)).toEqual([]);
    expect(warnings[0]).toContain("a symlink");
  });

  it("keeps a committed .claude directory untouched and reports it", () => {
    const { gitRoot, tree, target } = scene();
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "own.json"), "branch");

    const warnings = copyClaudeDir(gitRoot, tree);

    expect(fs.readdirSync(target)).toEqual(["own.json"]);
    expect(warnings[0]).toContain("a directory");
  });

  it("skips and reports a committed .claude file", () => {
    const { gitRoot, tree, target } = scene();
    fs.writeFileSync(target, "x");

    expect(copyClaudeDir(gitRoot, tree)[0]).toContain("a file");
    expect(fs.readFileSync(target, "utf8")).toBe("x");
  });

  it("does nothing when the main checkout has no .claude", () => {
    const { gitRoot, tree, target } = scene();
    fs.rmSync(path.join(gitRoot, ".claude"), { recursive: true });
    fs.symlinkSync("/nonexistent-target", target);

    expect(copyClaudeDir(gitRoot, tree)).toEqual([]);
  });
});
