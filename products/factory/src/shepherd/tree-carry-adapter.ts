import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDbPath } from "../config.js";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git against one bare repository; resolves with the exit code instead of rejecting. */
export type Git = (gitDir: string, args: readonly string[], signal?: AbortSignal) => Promise<GitResult>;

// Host effects behind the carry recipe: kept out of tree-carry.ts, which holds no I/O or clock use (D-M1b-07).
const GIT_TIMEOUT_MS = 10 * 60_000;

/** Never prompts and never reads a user credential helper; GitHub auth comes from `gh`. */
const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "",
  GIT_CONFIG_KEY_1: "credential.helper",
  GIT_CONFIG_VALUE_1: "!gh auth git-credential",
};

export const systemGit: Git = (gitDir, args, signal) =>
  new Promise((resolve) => {
    const options = { encoding: "utf8" as const, timeout: GIT_TIMEOUT_MS, signal, env: { ...process.env, ...GIT_ENV } };
    execFile("git", ["--git-dir", gitDir, ...args], options, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 128) : 0;
      resolve({ code, stdout, stderr: stderr || error?.message || "" });
    });
  });

export const configuredStateDir = (): string => dirname(resolveDbPath({ env: process.env }));
export const cacheInitialized = (dir: string): boolean => existsSync(join(dir, "HEAD"));
export const makeCacheParent = (dir: string): void => void mkdirSync(dirname(dir), { recursive: true });
