import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

// No real git prints a binary skip under --text today, so a stub stands in for a future one that does.
const BINARY_DIFF = ["diff --git a/m.bin b/m.bin", "index 0743be0..2577448 100644", "Binary files a/m.bin and b/m.bin differ", ""];

vi.mock("node:child_process", () => ({
  spawnSync: (_command: string, args: readonly string[]): SpawnSyncReturns<string> => {
    const stdout = args.includes("--no-patch") ? "message\n" : args[0] === "hash-object" ? "e69de29\n" : BINARY_DIFF.join("\n");
    return { pid: 0, output: [], stdout, stderr: "", status: 0, signal: null };
  },
}));

const { readCommit, readTree } = await import("./git.js");

describe("a binary skip that survives --text", () => {
  it("refuses the commit instead of counting the file as skipped", () => {
    expect(() => readCommit("/repo", "abcdef0123")).toThrow(
      "commit abcdef0: git printed a file as binary despite --text; refusing it",
    );
  });

  it("refuses the tree instead of counting the file as skipped", () => {
    expect(() => readTree("/repo")).toThrow("tree: git printed a file as binary despite --text; refusing it");
  });
});
