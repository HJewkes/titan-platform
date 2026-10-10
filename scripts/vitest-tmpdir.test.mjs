import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunTmpdir } from "./vitest-tmpdir.mjs";

describe("per-run test tmpdir", () => {
  let base;
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "vitest-tmpdir-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("points every temp variable at a fresh dir under the base", () => {
    const env = { TMPDIR: base };

    const remove = createRunTmpdir(env, base);

    expect(path.dirname(env.TMPDIR)).toBe(base);
    expect(env.TMP).toBe(env.TMPDIR);
    expect(env.TEMP).toBe(env.TMPDIR);
    expect(existsSync(env.TMPDIR)).toBe(true);
    remove();
  });

  it("removes the dir and what tests left in it, then restores the variables", () => {
    const env = { TMPDIR: base };
    const remove = createRunTmpdir(env, base);
    const dir = env.TMPDIR;
    writeFileSync(path.join(dir, "leak"), "x");

    remove();

    expect(existsSync(dir)).toBe(false);
    expect(env).toEqual({ TMPDIR: base });
  });

  it("reuses the dir a sibling project already created", () => {
    const env = { TMPDIR: base };
    const removeFirst = createRunTmpdir(env, base);
    const dir = env.TMPDIR;

    createRunTmpdir(env, base)();

    expect(env.TMPDIR).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    removeFirst();
  });
});
