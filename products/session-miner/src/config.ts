import os from "node:os";
import path from "node:path";
import { expandHome, transcriptsRoot } from "@titan-design/session-read";

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
  /** agent-chat's event log, read-only, where reviewer verdicts live. */
  eventsDb: string;
  /** agent-chat's broker log, read-only, where registrations, routes and exits are logged. */
  brokerLog: string;
}

export interface ConfigOverrides {
  codexHome?: string;
  namespace?: string;
  stateDir?: string;
  corpusRoot?: string;
  /** A graph another owner writes, such as active-work's; opened read-only in place of the miner's own. */
  graph?: string;
}

/**
 * Explicit overrides win, then the environment, then the defaults. The variables read are
 * `TITAN_MINER_STATE`, `TITAN_MINER_CORPUS`, `TITAN_MINER_CODEX_HOME`, `TITAN_MINER_NAMESPACE`,
 * `TITAN_MINER_GRAPH`, `TITAN_MINER_EVENTS_DB` and `TITAN_MINER_BROKER_LOG`.
 * A namespace without a Codex home throws, since it would otherwise be dropped silently.
 */
export function resolveConfig(overrides: ConfigOverrides = {}, env: NodeJS.ProcessEnv = process.env): MinerConfig {
  const stateDir = expandHome(overrides.stateDir ?? env.TITAN_MINER_STATE ?? path.join(os.homedir(), ".local", "state", "titan-session-miner"));
  const corpusRoot = expandHome(overrides.corpusRoot ?? env.TITAN_MINER_CORPUS ?? transcriptsRoot());
  const codexHome = overrides.codexHome ?? env.TITAN_MINER_CODEX_HOME;
  const namespace = overrides.namespace ?? env.TITAN_MINER_NAMESPACE;
  if (namespace !== undefined && !codexHome) throw new Error("--namespace / TITAN_MINER_NAMESPACE names a Codex corpus and needs --codex-home / TITAN_MINER_CODEX_HOME");
  const graph = overrides.graph ?? env.TITAN_MINER_GRAPH;
  const db = graph ? { dbPath: expandHome(graph), readonly: true } : { dbPath: path.join(stateDir, "index.sqlite3") };
  const eventsDb = expandHome(env.TITAN_MINER_EVENTS_DB ?? path.join(os.homedir(), ".agent-chat", "events.db"));
  const brokerLog = expandHome(env.TITAN_MINER_BROKER_LOG ?? path.join(os.homedir(), ".agent-chat", "broker.log"));
  return { stateDir, corpusRoot, eventsDb, brokerLog, ...db,
    ...(codexHome ? { codexHome: expandHome(codexHome), namespace: namespace ?? os.hostname() } : {}) };
}

