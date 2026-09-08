import type { BaseContext } from "@titan-design/registry";
import { openSessionGraph, type SessionGraph } from "@titan-design/session-graph";
import { runMigrations } from "@titan-design/store-sqlite";
import type { MinerConfig } from "./config.js";
import { MINER_MIGRATIONS } from "./schema.js";

export interface MinerContext extends BaseContext {
  config: MinerConfig;
  /** The open graph, created on first use so read-only commands never touch the disk needlessly. */
  graph(): SessionGraph;
  close(): void;
}

export function createMinerContext(config: MinerConfig, format: BaseContext["format"] = "json"): MinerContext {
  let graph: SessionGraph | undefined;
  return {
    warnings: [],
    format,
    config,
    graph() {
      if (!graph) {
        graph = openSessionGraph(config.dbPath);
        runMigrations(graph.db, MINER_MIGRATIONS);
      }
      return graph;
    },
    close() {
      graph?.db.close();
      graph = undefined;
    },
  };
}
