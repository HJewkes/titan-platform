import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFlatLog, createTreeTally } from "./test-footprint-watch.mjs";

const roots = [];

function root() {
  const dir = mkdtempSync(join(tmpdir(), "footprint-watch-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeWatch() {
  const callbacks = new Map();
  const watch = vi.fn((dir, callback) => {
    callbacks.set(dir, callback);
    return { on: vi.fn(), close: vi.fn(() => callbacks.delete(dir)) };
  });
  return { watch, callbacks };
}

const dirent = (name, isDir) => ({ name, isDirectory: () => isDir });
const missing = () => {
  throw new Error("ENOENT");
};

describe("the tree tally", () => {
  it("counts a real tree that fills before its watch lands", async () => {
    const base = root();
    const { tally, close } = createTreeTally({ root: base });

    mkdirSync(join(base, "f-one", "repo", ".git"), { recursive: true });
    writeFileSync(join(base, "f-one", "repo", ".git", "HEAD"), "ref");
    writeFileSync(join(base, "stray.txt"), "x");

    // Sums the tally: a footprint run of this test puts the whole root under its own f- dir.
    const totals = () => Object.values(tally.byDir).reduce((sum, { files, dirs }) => ({ files: sum.files + files, dirs: sum.dirs + dirs }), { files: 0, dirs: 0 });
    await vi.waitFor(() => expect(totals()).toEqual({ files: 2, dirs: 2 }));
    close();
  });

  it("counts a path once however often it is replaced", () => {
    const { watch, callbacks } = fakeWatch();
    const { tally } = createTreeTally({ root: "/r", watch, lstat: () => ({ isDirectory: () => false }), readdir: () => [] });

    for (let i = 0; i < 3; i += 1) callbacks.get("/r")("rename", "index.lock");

    expect(tally.byDir["(run root)"].files).toBe(1);
    expect(tally.events).toBe(3);
  });

  it("counts a file that was already gone when its event arrived", () => {
    const { watch, callbacks } = fakeWatch();
    const { tally } = createTreeTally({ root: "/r", watch, lstat: missing, readdir: () => [] });

    callbacks.get("/r")("rename", "f-x");
    callbacks.get("/r")("rename", "brief.tmp");

    expect(tally.byDir["(run root)"].files).toBe(1);
  });

  it("ignores content changes", () => {
    const { watch, callbacks } = fakeWatch();
    const { tally } = createTreeTally({ root: "/r", watch, lstat: missing, readdir: () => [] });

    callbacks.get("/r")("change", "a.txt");

    expect(tally.events).toBe(0);
  });

  it("drops the watch of a directory that was removed", () => {
    const { watch, callbacks } = fakeWatch();
    let exists = true;
    const lstat = () => (exists ? { isDirectory: () => true } : missing());
    createTreeTally({ root: "/r", watch, lstat, readdir: () => [] });

    callbacks.get("/r")("rename", "f-gone");
    expect(callbacks.has("/r/f-gone")).toBe(true);
    exists = false;
    callbacks.get("/r")("rename", "f-gone");

    expect(callbacks.has("/r/f-gone")).toBe(false);
  });

  it("counts what a new directory already holds", () => {
    const { watch, callbacks } = fakeWatch();
    const readdir = (dir) => (dir === "/r/f-x" ? [dirent("a", false), dirent("b", true)] : []);
    const { tally } = createTreeTally({ root: "/r", watch, lstat: () => ({ isDirectory: () => true }), readdir });

    callbacks.get("/r")("rename", "f-x");

    expect(tally.byDir["f-x"]).toEqual({ files: 1, dirs: 1 });
  });

  it("survives running out of watches and says how often", () => {
    const watch = vi.fn(() => {
      throw new Error("ENOSPC");
    });

    const { tally } = createTreeTally({ root: "/r", watch });

    expect(tally.watchFailures).toBe(1);
  });
});

describe("the flat log", () => {
  it("logs a new entry once, with its time, and skips other users' entries", () => {
    const { watch, callbacks } = fakeWatch();
    const owners = { mine: 1000, theirs: 0 };
    const { entries } = createFlatLog({ dir: "/s", watch, lstat: (path) => ({ uid: owners[path.split("/").pop()] }), now: () => 7, uid: 1000 });

    for (const name of ["mine", "mine", "theirs"]) callbacks.get("/s")("rename", name);

    expect(entries).toEqual([{ name: "mine", atMs: 7 }]);
  });

  it("skips an entry that vanished before it could be read", () => {
    const { watch, callbacks } = fakeWatch();
    const { entries } = createFlatLog({ dir: "/s", watch, lstat: missing, uid: 1000 });

    callbacks.get("/s")("rename", "gone");

    expect(entries).toEqual([]);
  });
});
