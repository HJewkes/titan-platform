import os from "node:os";
import path from "node:path";
import { activeWorkRoot } from "@titan-design/app-paths";
import { expandHome, transcriptsRoot } from "@titan-design/session-read";

/** Engineering initiatives whose done tasks calibrate throughput; personal and household ones stay out. */
export const DEFAULT_THROUGHPUT_INITIATIVES = ["titan-platform", "claude-channels", "titan-design", "relay", "codewatch", "voltras-workspace"];

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
  /** active-work's initiatives directory, where each initiative keeps `tasks/*.yml`. */
  initiativesRoot: string;
  /** The only initiatives whose tasks the throughput commands read. */
  throughputInitiatives: string[];
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
 * `TITAN_MINER_GRAPH`, `TITAN_MINER_EVENTS_DB`, `TITAN_MINER_BROKER_LOG`, `TITAN_MINER_INITIATIVES_ROOT`
 * and `TITAN_MINER_THROUGHPUT_INITIATIVES` (a comma list).
 * A namespace without a Codex home throws, since it would otherwise be dropped silently. An empty
 * initiative list throws too, since reading every initiative would let personal tasks in.
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
  const initiativesRoot = expandHome(env.TITAN_MINER_INITIATIVES_ROOT ?? activeWorkRoot({ env }));
  const throughputInitiatives = parseInitiatives(env.TITAN_MINER_THROUGHPUT_INITIATIVES);
  return { stateDir, corpusRoot, eventsDb, brokerLog, initiativesRoot, throughputInitiatives, ...db,
    ...(codexHome ? { codexHome: expandHome(codexHome), namespace: namespace ?? os.hostname() } : {}) };
}


function parseInitiatives(list: string | undefined): string[] {
  if (list === undefined) return [...DEFAULT_THROUGHPUT_INITIATIVES];
  const initiatives = list.split(",").map((name) => name.trim()).filter(Boolean);
  if (initiatives.length === 0) throw new Error("TITAN_MINER_THROUGHPUT_INITIATIVES is set but names no initiative");
  return initiatives;
}
