import os from "node:os";
import path from "node:path";
import { transcriptsRoot } from "@titan-design/session-read";

export interface MinerConfig {
  /** Holds the index database, the daemon pid file, and the clusterer snapshot. */
  stateDir: string;
  /** Root of the transcript corpus, `~/.claude/projects` by default. */
  corpusRoot: string;
  dbPath: string;
  /** Set when `dbPath` is a graph another process owns: the miner reads it and never migrates or writes it. */
  readonly?: boolean;
  /** Optional Codex home; enabled explicitly to preserve existing corpus defaults. */
  codexHome?: string;
  namespace?: string;
}

export interface ConfigOverrides {
  codexHome?: string;
  namespace?: string;
  stateDir?: string;
  corpusRoot?: string;
  /** A graph another owner writes, such as active-work's; opened read-only in place of the miner's own. */
  graph?: string;
}

/** Explicit overrides win, then `TITAN_MINER_STATE` / `TITAN_MINER_CORPUS` / `TITAN_MINER_GRAPH`, then the defaults. */
export function resolveConfig(overrides: ConfigOverrides = {}, env: NodeJS.ProcessEnv = process.env): MinerConfig {
  const stateDir = expandHome(overrides.stateDir ?? env.TITAN_MINER_STATE ?? path.join(os.homedir(), ".local", "state", "titan-session-miner"));
  const corpusRoot = expandHome(overrides.corpusRoot ?? env.TITAN_MINER_CORPUS ?? transcriptsRoot());
  const codexHome = overrides.codexHome ?? env.TITAN_MINER_CODEX_HOME;
  const graph = overrides.graph ?? env.TITAN_MINER_GRAPH;
  const db = graph ? { dbPath: expandHome(graph), readonly: true } : { dbPath: path.join(stateDir, "index.sqlite3") };
  return { stateDir, corpusRoot, ...db,
    ...(codexHome ? { codexHome: expandHome(codexHome), namespace: overrides.namespace ?? env.TITAN_MINER_NAMESPACE ?? os.hostname() } : {}) };
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}
