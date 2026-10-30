import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunTmpdir, removeOrphanRunDirs } from "./vitest-tmpdir.mjs";

const MODULE = new URL("./vitest-tmpdir.mjs", import.meta.url).href;

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

  it("leaves nothing behind when a killed run is followed by a clean one", () => {
    const killed = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `import { createRunTmpdir } from ${JSON.stringify(MODULE)}; createRunTmpdir({}, process.argv[1]); process.kill(process.pid, "SIGKILL");`, base],
      { encoding: "utf8" },
    );
    expect(killed.signal).toBe("SIGKILL");
    expect(readdirSync(base)).toHaveLength(1);

    createRunTmpdir({ TMPDIR: base }, base)();

    expect(readdirSync(base)).toEqual([]);
  });

  it("keeps a dir whose run is still alive", () => {
    const live = path.join(base, `vt-titan-platform-${process.pid}-live`);
    mkdirSync(live);

    removeOrphanRunDirs(base);

    expect(existsSync(live)).toBe(true);
  });

  it("removes a dead run's dir and spares names it does not own", () => {
    const dead = path.join(base, "vt-titan-platform-4242-dead");
    const other = path.join(base, "vt-titan-platform-legacy");
    mkdirSync(dead);
    mkdirSync(other);
    writeFileSync(path.join(dead, "leak"), "x");

    removeOrphanRunDirs(base, () => false);

    expect(existsSync(dead)).toBe(false);
    expect(existsSync(other)).toBe(true);
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
