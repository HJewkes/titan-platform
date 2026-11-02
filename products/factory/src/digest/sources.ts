import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FactoryConfig } from "../config.js";
import { loadSeatBook } from "../shepherd/seats.js";
import type { DigestSources } from "./collect.js";
import { readQueueAsks } from "./queues.js";

export const AGENT_CHAT_TIMEOUT_MS = 20_000;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;

export const execProcess: Exec = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, [...args], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout, stderr: stderr || error?.message || "" });
    });
  });

export interface Directories {
  outDir: string;
  copyDirs: string[];
}

export function digestDirectories(config: FactoryConfig, env: NodeJS.ProcessEnv): Directories {
  const outDir = config.digest?.outDir ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "titan-factory", "digests");
  const copyDirs = [...new Set([...(config.digest?.copyDirs ?? []), ...(config.digest?.icloudDir ? [config.digest.icloudDir] : [])])];
  return { outDir, copyDirs };
}

/** Where the seats' Morning queue files live: the configured dir, else `queues` beside the seat book. */
export function queuesDirOf(config: FactoryConfig): string {
  return config.digest?.queuesDir ?? join(config.shepherd?.seatsDir ? dirname(config.shepherd.seatsDir) : "", "queues");
}

/** Queue files for every seat in the seat book; an unset seats dir is a gap, not a guess. */
export function fileSources(config: FactoryConfig): Pick<DigestSources, "queueAsks"> {
  const seatsDir = config.shepherd?.seatsDir;
  const seatNames = (): string[] => {
    if (!seatsDir) throw new Error("shepherd.seatsDir is not configured");
    return loadSeatBook({ seatsDir }).seats.map((seat) => seat.name);
  };
  return { queueAsks: () => readQueueAsks(queuesDirOf(config), seatNames()) };
}
