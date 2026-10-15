import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSnapshotFunctions } from "./snapshot-functions.js";
import { trustedFunctions, zshParses } from "./snapshot-verify.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const spawn = vi.mocked(spawnSync);
const GP = ["# Functions", "gp () {", "\tgit push", "}", "# Shell Options"].join("\n");

function spawnResult(result: Partial<ReturnType<typeof spawnSync>>): ReturnType<typeof spawnSync> {
  return { pid: 0, output: [], stdout: "", stderr: "", status: null, signal: null, ...result };
}

describe("zshParses when zsh cannot answer", () => {
  afterEach(() => {
    spawn.mockReset();
  });

  it("fails closed when zsh is not on PATH", () => {
    spawn.mockReturnValue(spawnResult({ error: Object.assign(new Error("spawnSync zsh ENOENT"), { code: "ENOENT" }) }));

    expect(trustedFunctions(parseSnapshotFunctions(GP))("gp")).toEqual({ unreadable: true });
  });

  it("fails closed when the parse times out", () => {
    spawn.mockReturnValue(spawnResult({ error: Object.assign(new Error("spawnSync zsh ETIMEDOUT"), { code: "ETIMEDOUT" }), signal: "SIGTERM" }));

    expect(zshParses("gp () {\n\tgit push\n}")).toBe(false);
  });

  it("asks zsh to parse without running and without startup files", () => {
    spawn.mockReturnValue(spawnResult({ status: 0 }));

    expect(zshParses("gp () {\n\tgit push\n}")).toBe(true);
    expect(spawn).toHaveBeenCalledWith("zsh", ["-f", "-n"], expect.objectContaining({ input: "gp () {\n\tgit push\n}" }));
  });
});
