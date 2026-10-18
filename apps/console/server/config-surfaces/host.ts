import path from "node:path";
import { expandHome } from "@titan-design/session-read";
import { agentChatSurfaces } from "./agent-chat.js";
import type { SurfaceReader } from "./catalog.js";
import { claudeSurfaces, type ClaudeAccounts } from "./claude.js";
import { consoleEnvSurfaces, factorySurfaces } from "./factory.js";

/** Where `config.surfaces` reads this host's agent-chat, factory, console and Claude Code config. */
export interface HostSurfaceRoots {
  agentChatDir: string;
  factoryConfigPath: string;
  claude: ClaudeAccounts;
  /** The `TITAN_CONSOLE_*` variables the daemon started with, and when they were read. */
  consoleEnv: Readonly<Record<string, string>>;
  readAt: string;
}

function claudeAccountsFrom(raw: string | undefined, home: string): ClaudeAccounts {
  if (raw === undefined || raw.trim() === "") return { dirs: [path.join(home, ".claude")], profilesDir: path.join(home, ".claude-profiles") };
  const dirs = raw.split(",").map((dir) => dir.trim()).filter((dir) => dir !== "");
  return { dirs: dirs.map((dir) => expandHome(dir, home)), profilesDir: null };
}

const consoleEnvFrom = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[0].startsWith("TITAN_CONSOLE_") && entry[1] !== undefined));

/** `TITAN_CONSOLE_CLAUDE_DIRS` (a comma list) replaces the default of `~/.claude` plus every `~/.claude-profiles/*`. */
export function hostSurfaceRootsFrom(env: NodeJS.ProcessEnv, home: string, now: Date = new Date()): HostSurfaceRoots {
  const factoryDefault = path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "titan-factory", "config.json");
  return {
    agentChatDir: expandHome(env.AGENT_CHAT_HOME ?? "~/.agent-chat", home),
    factoryConfigPath: expandHome(env.TITAN_CONSOLE_FACTORY_CONFIG || factoryDefault, home),
    claude: claudeAccountsFrom(env.TITAN_CONSOLE_CLAUDE_DIRS, home),
    consoleEnv: consoleEnvFrom(env),
    readAt: now.toISOString(),
  };
}

export function hostSurfaces(roots: HostSurfaceRoots): SurfaceReader[] {
  return [agentChatSurfaces(roots.agentChatDir), factorySurfaces(roots.factoryConfigPath), consoleEnvSurfaces(roots.consoleEnv, roots.readAt), claudeSurfaces(roots.claude)];
}
