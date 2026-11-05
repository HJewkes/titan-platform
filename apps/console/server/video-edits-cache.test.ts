import { describe, expect, it, vi } from "vitest";
import { editsStamp, stampedMemo, type StampFs } from "./video-edits-cache.js";

const DATA = "/data/explainer";

interface FakeStore {
  files: Map<string, { mtimeMs: number; size: number }>;
  link: string | null;
}

function fakeStore(): FakeStore {
  return {
    files: new Map([
      [`${DATA}/edits/edit-a.json`, { mtimeMs: 10, size: 100 }],
      [`${DATA}/state.sqlite3`, { mtimeMs: 20, size: 4096 }],
    ]),
    link: "releases/aaa",
  };
}

const fakeFs = (store: FakeStore): StampFs => ({
  readdir: async () => [...store.files.keys()].filter((file) => file.includes("/edits/")).map((file) => file.split("/").pop()!),
  stat: async (file) => store.files.get(file) ?? null,
  readlink: async () => store.link,
});

function memoOver(store: FakeStore, spawn: () => Promise<{ ok: boolean }>) {
  return stampedMemo(() => editsStamp(DATA, fakeFs(store)), spawn, (read) => read.ok);
}

describe("the edit list memo", () => {
  it("spawns once for two calls when nothing changed", async () => {
    const spawn = vi.fn(async () => ({ ok: true }));
    const read = memoOver(fakeStore(), spawn);

    await read("sha-1");
    await read("sha-1");

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("spawns again when an edit file is rewritten in place", async () => {
    const store = fakeStore();
    const spawn = vi.fn(async () => ({ ok: true }));
    const read = memoOver(store, spawn);
    await read("sha-1");

    store.files.set(`${DATA}/edits/edit-a.json`, { mtimeMs: 11, size: 100 });
    await read("sha-1");

    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("spawns again when a linked run changes the state database", async () => {
    const store = fakeStore();
    const spawn = vi.fn(async () => ({ ok: true }));
    const read = memoOver(store, spawn);
    await read("sha-1");

    store.files.set(`${DATA}/state.sqlite3-wal`, { mtimeMs: 30, size: 32 });
    await read("sha-1");

    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("spawns again when the CLI release target changes", async () => {
    const store = fakeStore();
    const spawn = vi.fn(async () => ({ ok: true }));
    const read = memoOver(store, spawn);
    await read("sha-1");

    store.link = "releases/bbb";
    await read("sha-1");

    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failing spawn", async () => {
    const spawn = vi.fn(async () => ({ ok: false }));
    const read = memoOver(fakeStore(), spawn);

    await read("sha-1");
    await read("sha-1");

    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("keeps each video's answer apart", async () => {
    const spawn = vi.fn(async () => ({ ok: true }));
    const read = memoOver(fakeStore(), spawn);

    await read("sha-1");
    await read("sha-2");

    expect(spawn).toHaveBeenCalledTimes(2);
  });
});
