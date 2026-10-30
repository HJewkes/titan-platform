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

async function cli(address: BrokerAddress, args: string[]): Promise<string> {
  const { stdout } = await run(address.cli, args, { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
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

export function nodeSources(address: BrokerAddress, env: NodeJS.ProcessEnv): FeedSources {
  return {
    roster: async () => parseRoster(await cli(address, ["agent", "ls", "--json"])),
    accounts: async () => parseAccounts(await cli(address, ["agent", "budget", "--accounts", "--json"])),
    slots: async () => {
      const res = await fetch(`http://127.0.0.1:${address.port}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`/health answered ${res.status}`);
      return parseSlots(await res.text());
    },
    statusLine: (entry) => statusLine(entry, env),
  };
}
