import type { SpawnSyncReturns } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted((): { error: Error | undefined } => ({ error: undefined }));

vi.mock("node:child_process", () => ({
  spawnSync: (_command: string, args: readonly string[]): SpawnSyncReturns<string> => {
    // The empty-tree lookup runs ahead of the patch read that this file is about.
    const error = args[0] === "hash-object" ? undefined : spawned.error;
    return { pid: 0, output: [], stdout: "e69de29\n", stderr: "", status: error === undefined ? 0 : null, signal: null, error };
  },
}));

const { PatchTooLargeError, readCommit, readTree } = await import("./git.js");

const SHA = "abcdef0123";
const withCode = (code: string): Error => Object.assign(new Error("spawn failed"), { code });

describe("a spawn error while reading patch text", () => {
  beforeEach(() => {
    spawned.error = undefined;
  });

  it("reports an over-buffer commit as too large", () => {
    spawned.error = withCode("ENOBUFS");
    expect(() => readCommit("/repo", SHA)).toThrow(PatchTooLargeError);
  });

  it("reports an over-buffer tree as too large", () => {
    spawned.error = withCode("ENOBUFS");
    expect(() => readTree("/repo")).toThrow(PatchTooLargeError);
  });

  it.each([
    ["another errno code", withCode("ENOENT")],
    ["a code in the wrong case", withCode("enobufs")],
    ["no code", new Error("spawn failed")],
  ])("still fails, but not as too large, on %s", (_label, error) => {
    spawned.error = error;
    expect(() => readCommit("/repo", SHA)).toThrow();
    expect(() => readCommit("/repo", SHA)).not.toThrow(PatchTooLargeError);
  });
});
