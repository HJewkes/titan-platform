import { describe, expect, it } from "vitest";
import { deployLockPath, runningDeployer } from "./deploy-lock.js";

const STATE = "/srv/state";

const lockWith = (text: string | undefined, alive: number[]) => ({
  readFile: (path: string) => (path === deployLockPath(STATE) ? text : undefined),
  isAlive: (pid: number) => alive.includes(pid),
});

describe("runningDeployer", () => {
  it("names the pid in the deploy lock while that process is alive", () => {
    expect(runningDeployer(lockWith("4321\n", [4321]), STATE)).toBe(4321);
  });

  it("reads a lock whose pid is dead as no deployer", () => {
    expect(runningDeployer(lockWith("4321", []), STATE)).toBeUndefined();
  });

  it("reads an absent lock as no deployer", () => {
    expect(runningDeployer(lockWith(undefined, [4321]), STATE)).toBeUndefined();
  });

  it("reads a lock that holds no pid as no deployer", () => {
    expect(runningDeployer(lockWith("not-a-pid", [0]), STATE)).toBeUndefined();
  });
});
