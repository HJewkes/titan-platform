import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import type { DeployerPorts } from "./redeploy.js";

// Host effects behind the redeploy recipe: kept out of redeploy.ts, which holds no I/O or clock use (D-M1b-07).
export const nodeDeployerPorts: DeployerPorts = {
  spawn: (file, args, options) => spawn(file, args, options),
  mkdir: (dir) => void mkdirSync(dir, { recursive: true }),
  append: (path, text) => appendFileSync(path, text),
  openAppend: (path) => openSync(path, "a"),
  close: (fd) => closeSync(fd),
};

export const wallClock = (): Date => new Date();
export const hostExecPath = (): string => process.execPath;
export const hostPlatform = (): NodeJS.Platform => process.platform;
