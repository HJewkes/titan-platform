import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FactoryConfig } from "../config.js";
import { loadSeatBook } from "../shepherd/seats.js";
import type { DigestSources } from "./collect.js";
import { AgentChatDigestSchema, type AgentChatDigest } from "./model.js";
import { readQueueAsks } from "./queues.js";
import { readSeatCosts } from "./seats.js";

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

/** An agent-chat with no `--json` exits non-zero, which the collector turns into a gap line. */
export async function readAgentChat(exec: Exec, bin: string, windowMinutes: number): Promise<AgentChatDigest> {
  const result = await exec(bin, ["digest", "--json", "--prs", "--since", `${windowMinutes}m`], AGENT_CHAT_TIMEOUT_MS);
  if (result.code !== 0) throw new Error(`exit ${result.code}: ${result.stderr.trim().split("\n")[0] ?? ""}`);
  const parsed = AgentChatDigestSchema.safeParse(JSON.parse(result.stdout));
  if (!parsed.success) throw new Error(`unexpected JSON: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

export interface Directories {
  outDir: string;
  copyDirs: string[];
}

export function digestDirectories(config: FactoryConfig, env: NodeJS.ProcessEnv): Directories {
  const outDir = config.digest?.outDir ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "titan-factory", "digests");
  const copyDirs = [...new Set([...(config.digest?.copyDirs ?? []), ...(config.digest?.icloudDir ? [config.digest.icloudDir] : [])])];
  return { outDir, copyDirs };
}

/** Queue and dispatch files for every seat in the seat book; an unset seats dir is a gap, not a guess. */
export function fileSources(config: FactoryConfig): Pick<DigestSources, "queueAsks" | "seatCosts"> {
  const seatsDir = config.shepherd?.seatsDir;
  const seatNames = (): string[] => {
    if (!seatsDir) throw new Error("shepherd.seatsDir is not configured");
    return loadSeatBook({ seatsDir }).seats.map((seat) => seat.name);
  };
  const root = seatsDir ? dirname(seatsDir) : "";
  return {
    queueAsks: () => readQueueAsks(config.digest?.queuesDir ?? join(root, "queues"), seatNames()),
    seatCosts: (since) => readSeatCosts(config.digest?.logsDir ?? join(root, "logs"), seatNames(), since),
  };
}
