import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

describe("host state isolation", () => {
  const LIVE = "/synthetic/operator";
  let base;
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "vitest-host-state-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("moves every state root an agent exports into one empty home inside the run dir", () => {
    const env = { HOME: LIVE, AGENT_CHAT_HOME: `${LIVE}/.agent-chat`, CLAUDE_CONFIG_DIR: `${LIVE}/.claude-profiles/a`, ACTIVE_ROOT: `${LIVE}/aw` };

    const remove = createRunTmpdir(env, base);

    const home = path.join(env.TMPDIR, "host-state");
    expect(env.HOME).toBe(home);
    expect(readdirSync(home)).toEqual([]);
    expect(env.AGENT_CHAT_HOME).toBe(path.join(home, ".agent-chat"));
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(home, ".claude"));
    expect(env.ACTIVE_ROOT).toBe(path.join(home, "active-work"));
    expect(env.XDG_STATE_HOME).toBe(path.join(home, ".local/state"));
    remove();
  });

  it("drops an override that would point past the empty home", () => {
    const env = { HOME: LIVE, TITAN_FACTORY_DB: `${LIVE}/factory.sqlite3`, CLAUDE_CONFIG_DIRS: `${LIVE}/.claude` };

    const remove = createRunTmpdir(env, base);

    expect(env).not.toHaveProperty("TITAN_FACTORY_DB");
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIRS");
    remove();
  });

  it("leaves tool caches on the real home, and honours one already set", () => {
    const env = { HOME: LIVE, NPM_CONFIG_CACHE: "/synthetic/npm" };

    const remove = createRunTmpdir(env, base);

    expect(env.XDG_CACHE_HOME).toBe(path.join(LIVE, ".cache"));
    expect(env.COREPACK_HOME).toBe(path.join(LIVE, ".cache/node/corepack"));
    expect(env.NPM_CONFIG_CACHE).toBe("/synthetic/npm");
    remove();
  });

  it("puts every variable back when the run ends", () => {
    const before = { HOME: LIVE, TMPDIR: base, AGENT_CHAT_HOME: `${LIVE}/.agent-chat`, TITAN_FACTORY_DB: `${LIVE}/db` };
    const env = { ...before };

    createRunTmpdir(env, base)();

    expect(env).toEqual(before);
  });

  it("leaves the host alone for a run that opts in", () => {
    const env = { HOME: LIVE, AGENT_CHAT_HOME: `${LIVE}/.agent-chat`, TITAN_TEST_HOST_STATE: "1" };

    const remove = createRunTmpdir(env, base);

    expect(env.HOME).toBe(LIVE);
    expect(env.AGENT_CHAT_HOME).toBe(`${LIVE}/.agent-chat`);
    remove();
  });

  it("holds for this very worker, whose homedir() a thread cannot stub", () => {
    const home = path.join(process.env.TITAN_TEST_TMPDIR, "host-state");

    expect(homedir()).toBe(home);
    expect(process.env.AGENT_CHAT_HOME).toBe(path.join(home, ".agent-chat"));
  });
});
