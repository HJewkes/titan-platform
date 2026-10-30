import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FeedSources } from "./feed.js";
import { parseAccounts, parseRoster, parseSlots, parseStatusLine, type RosterEntry } from "./inputs.js";

const run = promisify(execFile);

export interface BrokerAddress {
  /** The agent-chat CLI to run, as found on PATH or an absolute path. */
  cli: string;
  /** agent-chat's state dir, which holds `ui.token`. */
  home: string;
  port: number;
}

/** The same overrides agent-chat itself reads, so the feed follows a test or relocated broker. */
export function brokerAddress(env: NodeJS.ProcessEnv): BrokerAddress {
  const port = Number.parseInt(env.AGENT_CHAT_PORT ?? "", 10);
  return {
    cli: env.FLEET_AGENT_CHAT_CLI ?? "agent-chat",
    home: env.AGENT_CHAT_HOME ?? join(homedir(), ".agent-chat"),
    port: Number.isInteger(port) && port > 0 ? port : 7600,
  };
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Where a session's status line writes its reading, under the account it runs on. */
function statusLinePath(entry: RosterEntry, env: NodeJS.ProcessEnv): string | null {
  if (!SESSION_ID.test(entry.sessionId)) return null;
  const dir = env.AGENT_CHAT_STATUS_CACHE ?? join(entry.configDir ?? join(homedir(), ".claude"), "status-cache", "sessions");
  return join(dir, `${entry.sessionId}.json`);
}

export interface CliOptions {
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
}

/** Runs one CLI and resolves its stdout; `execFile` in production, a fake in tests. */
export type CliRunner = (file: string, args: string[], options: CliOptions) => Promise<{ stdout: string }>;

const execRunner: CliRunner = (file, args, options) => run(file, args, { ...options, encoding: "utf8" });

/**
 * agent-chat's client starts a broker when it finds none. A panel that polls every 15 s must
 * only read, never bring back a broker someone stopped, so every call forbids the autostart.
 */
function cliOptions(env: NodeJS.ProcessEnv): CliOptions {
  return { env: { ...env, AGENT_CHAT_NO_AUTOSTART: "1" }, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 };
}

async function statusLine(entry: RosterEntry, env: NodeJS.ProcessEnv) {
  const path = statusLinePath(entry, env);
  if (path === null) return null;
  try {
    return parseStatusLine(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export function nodeSources(address: BrokerAddress, env: NodeJS.ProcessEnv, runner: CliRunner = execRunner): FeedSources {
  const cli = async (args: string[]) => (await runner(address.cli, args, cliOptions(env))).stdout;
  return {
    roster: async () => parseRoster(await cli(["agent", "ls", "--json"])),
    accounts: async () => parseAccounts(await cli(["agent", "budget", "--accounts", "--json"])),
    slots: async () => {
      const res = await fetch(`http://127.0.0.1:${address.port}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`/health answered ${res.status}`);
      return parseSlots(await res.text());
    },
    statusLine: (entry) => statusLine(entry, env),
  };
}
