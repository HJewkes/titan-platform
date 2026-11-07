import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveDbPath } from "../config.js";
import type { CacheFs, Git, GitCachePorts } from "./git-cache-ports.js";

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

export const nodeCacheFs: CacheFs = {
  exists: (path) => existsSync(path),
  mkdirp: (dir) => {
    mkdirSync(dir, { recursive: true });
  },
};

let boundStateDir: string | undefined;

/** The server binds its state dir so the cache sits beside its database; the returned function unbinds it. */
export function bindCarryStateDir(stateDir: string): () => void {
  boundStateDir = stateDir;
  return () => {
    if (boundStateDir === stateDir) boundStateDir = undefined;
  };
}

/** The state dir is read on every probe, since the server binds it only after the routes that hold these ports are built. */
export const hostCarryPorts: GitCachePorts = {
  git: systemGit,
  fs: nodeCacheFs,
  stateDir: () => boundStateDir ?? dirname(resolveDbPath({ env: process.env })),
};
