import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";

// Host effects behind the redeploy recipe: kept out of redeploy.ts, which holds no I/O or clock use (D-M1b-07).
/** The effects `systemDeployer` has; tests pass fakes, so none of them starts a process. */
export interface DeployerPorts {
  spawn: (file: string, args: readonly string[], options: SpawnOptions) => Pick<ChildProcess, "pid" | "unref" | "on">;
  mkdir: (dir: string) => void;
  append: (path: string, text: string) => void;
  openAppend: (path: string) => number;
  close: (fd: number) => void;
}

export const nodeDeployerPorts: DeployerPorts = {
  spawn: (file, args, options) => spawn(file, args, options),
  mkdir: (dir) => void mkdirSync(dir, { recursive: true }),
  append: (path, text) => appendFileSync(path, text),
  openAppend: (path) => openSync(path, "a"),
  close: (fd) => closeSync(fd),
};

/** The clock, program and platform a `systemDeployer` runs on; callers add `bin`, `stateDir` and `isAncestor`. */
export const hostDeployerOptions = (): { now: () => Date; node: string; platform: NodeJS.Platform } => ({ now: () => new Date(), node: process.execPath, platform: process.platform });
