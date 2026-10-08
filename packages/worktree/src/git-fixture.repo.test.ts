import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTemplates, seedRepo, templateDirectory } from "./git-fixture.js";

const tmpdirs: string[] = [];

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function emptyDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-fixture-test-"));
  tmpdirs.push(dir);
  return dir;
}

describe("template cleanup", () => {
  it("deletes the template directory, and the next seed builds a fresh one", () => {
    seedRepo(emptyDir());
    const first = templateDirectory();
    expect(first && fs.existsSync(first)).toBe(true);

    removeTemplates();

    expect(fs.existsSync(first!)).toBe(false);
    const repo = emptyDir();
    seedRepo(repo);
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("seed\n");
    expect(templateDirectory()).not.toBe(first);
  });
});
