import { PlaybookStore, type Reflector } from "@titan-design/memory";
import type { BaseContext } from "@titan-design/registry";
import { openSessionGraph, type SessionGraph } from "@titan-design/session-graph";
import { runMigrations } from "@titan-design/store-sqlite";
import type { MinerConfig } from "./config.js";
import { MINER_MIGRATIONS } from "./schema.js";

export interface MinerContext extends BaseContext {
  config: MinerConfig;
  /** The open graph, created on first use so read-only commands never touch the disk needlessly. */
  graph(): SessionGraph;
  /** The rule playbook, in the same database. Strictly downstream: it never writes back to the graph. */
  playbook(): PlaybookStore;
  /** Supplied by an embedder that wants batch reflection; absent means the deterministic path only. */
  reflector?: Reflector;
  close(): void;
}

export interface MinerContextOptions {
  format?: BaseContext["format"];
  reflector?: Reflector;
}

export function createMinerContext(config: MinerConfig, options: BaseContext["format"] | MinerContextOptions = {}): MinerContext {
  const { format = "json", reflector } = typeof options === "string" ? { format: options } : options;
  let graph: SessionGraph | undefined;
  let playbook: PlaybookStore | undefined;
  const ctx: MinerContext = {
    warnings: [],
    format,
    config,
    reflector,
    graph() {
      if (!graph) {
        graph = openSessionGraph(config.dbPath);
        runMigrations(graph.db, MINER_MIGRATIONS);
      }
      return graph;
    },
    playbook() {
      playbook ??= new PlaybookStore(ctx.graph().db);
      return playbook;
    },
    close() {
      graph?.db.close();
      graph = undefined;
      playbook = undefined;
    },
  };
  return ctx;
}
