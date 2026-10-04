import os from "node:os";
import path from "node:path";
import type { SeatPrefix } from "@titan-design/chat-protocol/agents";

/** Off 7400, which the active-work daemon and `titan-miner serve` both default to. */
export const DEFAULT_CONSOLE_PORT = 7500;
const ACTIVE_WORK_PORT = 7400;
const AGENT_CHAT_PORT = 7600;

export interface ConsoleConfig {
  /** 0 binds an ephemeral port. */
  port: number;
  /** Holds the console daemon's pid file. */
  stateDir: string;
  /** Loopback ports of the two upstream daemons; the console never starts either. */
  activeWorkPort: number;
  agentChatPort: number;
  /** agent-chat's `ui.token`; the broker's `/api/*` reads need it in a header. */
  agentChatTokenPath: string;
  /** Which seat owns the agents named `<prefix>-...`. */
  seatPrefixes: SeatPrefix[];
  sessionGraphPath: string;
}

/** `TITAN_CONSOLE_*` overrides win, then the defaults; a port shared with an upstream is refused. */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): ConsoleConfig {
  const config: ConsoleConfig = {
    port: portFrom(env, "TITAN_CONSOLE_PORT", DEFAULT_CONSOLE_PORT),
    stateDir: expandHome(env.TITAN_CONSOLE_STATE ?? "~/.local/state/titan-console", home),
    activeWorkPort: portFrom(env, "TITAN_CONSOLE_ACTIVE_WORK_PORT", ACTIVE_WORK_PORT),
    agentChatPort: portFrom(env, "TITAN_CONSOLE_AGENT_CHAT_PORT", AGENT_CHAT_PORT),
    agentChatTokenPath: expandHome(env.TITAN_CONSOLE_AGENT_CHAT_TOKEN ?? path.join(env.AGENT_CHAT_HOME ?? "~/.agent-chat", "ui.token"), home),
    seatPrefixes: seatPrefixesFrom(env.TITAN_CONSOLE_SEATS),
    sessionGraphPath: expandHome(env.TITAN_CONSOLE_SESSION_GRAPH ?? path.join(activeWorkRoot(env, home), ".miner", "graph.sqlite3"), home),
  };
  if (config.port === config.activeWorkPort || config.port === config.agentChatPort) {
    throw new Error(`TITAN_CONSOLE_PORT ${config.port} belongs to an upstream daemon; the console needs a port of its own`);
  }
  return config;
}

function portFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  // A typo that silently bound another port would be worse than a refusal.
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${name} must be a port number, got "${raw}"`);
  return port;
}

/** `TITAN_CONSOLE_SEATS` is `seat=prefix` pairs separated by commas, e.g. `titan-coord=tpc`. */
function seatPrefixesFrom(raw: string | undefined): SeatPrefix[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",").map((pair) => {
    const [seat, prefix, extra] = pair.split("=").map((part) => part.trim());
    if (!seat || !prefix || extra !== undefined) throw new Error(`TITAN_CONSOLE_SEATS entries must be seat=prefix, got "${pair}"`);
    return { seat, prefix };
  });
}

/** active-work's data directory: `ACTIVE_ROOT`, else the env-paths location its own CLI resolves. */
function activeWorkRoot(env: NodeJS.ProcessEnv, home: string): string {
  if (env.ACTIVE_ROOT) return path.resolve(expandHome(env.ACTIVE_ROOT, home));
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "active-work");
  return path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "active-work");
}

function expandHome(file: string, home: string): string {
  return file.startsWith("~/") ? path.join(home, file.slice(2)) : file;
}
