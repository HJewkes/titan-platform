import os from "node:os";
import path from "node:path";
import { transcriptsRoot } from "@titan-design/session-read";

export interface MinerConfig {
  /** Holds the index database, the daemon pid file, and the clusterer snapshot. */
  stateDir: string;
  /** Root of the transcript corpus, `~/.claude/projects` by default. */
  corpusRoot: string;
  dbPath: string;
}

export interface ConfigOverrides {
  stateDir?: string;
  corpusRoot?: string;
}

/** Explicit overrides win, then `TITAN_MINER_STATE` / `TITAN_MINER_CORPUS`, then the defaults. */
export function resolveConfig(overrides: ConfigOverrides = {}, env: NodeJS.ProcessEnv = process.env): MinerConfig {
  const stateDir = expandHome(overrides.stateDir ?? env.TITAN_MINER_STATE ?? path.join(os.homedir(), ".local", "state", "titan-session-miner"));
  const corpusRoot = expandHome(overrides.corpusRoot ?? env.TITAN_MINER_CORPUS ?? transcriptsRoot());
  return { stateDir, corpusRoot, dbPath: path.join(stateDir, "index.sqlite3") };
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}
