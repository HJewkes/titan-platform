import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "./fixtures/git-repo.js";
import { lsofCwds, lsofCwdsWith, type LsofRunner } from "./park-tree.js";

afterEach(removeTempDirs);

const hasLsof = (): boolean => spawnSync("lsof", ["-v"], { stdio: "ignore" }).error === undefined;

const exiting =
  (status: number, stdout = ""): LsofRunner =>
  async () => ({ stdout, status });

const unstartable: LsofRunner = () => Promise.reject(new Error("lsof could not be started"));

describe("listing process working directories with lsof (CC-282)", () => {
  it("parses a clean run", async () => {
    const list = lsofCwdsWith(exiting(0, "p12\nn/a/b\np34\nn/c\n"));

    expect(await list()).toEqual([
      { pid: 12, cwd: "/a/b" },
      { pid: 34, cwd: "/c" },
    ]);
  });

  it("reads an empty exit 1 as no processes", async () => {
    expect(await lsofCwdsWith(exiting(1))()).toEqual([]);
  });

  it("uses the output of an exit 1 that carries partial results", async () => {
    const list = lsofCwdsWith(exiting(1, "p12\nn/a/b\nWARNING: no such file\n"));

    expect(await list()).toEqual([{ pid: 12, cwd: "/a/b" }]);
  });

  it.each([
    ["a missing lsof", unstartable],
    ["another exit code", exiting(2, "p12\nn/a/b\n")],
    ["unparseable output on exit 1", exiting(1, "lsof: WARNING: something odd\n")],
  ])("still throws for %s", async (_name, run) => {
    await expect(lsofCwdsWith(run)()).rejects.toThrow();
  });

  it.runIf(hasLsof())("finds a real child process through lsof", async () => {
    const dir = tempDir("lsof-");
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { cwd: dir, stdio: "ignore" });
    try {
      await new Promise((resolve) => child.once("spawn", resolve));

      expect(await lsofCwds()).toContainEqual({ pid: child.pid, cwd: dir });
    } finally {
      child.kill("SIGKILL");
    }
  });
});
