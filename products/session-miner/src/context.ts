import { PlaybookStore, type Reflector } from "@titan-design/memory";
import type { BaseContext } from "@titan-design/registry";
import { PRICE_TABLE, PRICE_TABLE_VERSION } from "@titan-design/session-analytics";
import { openSessionGraph, reconcilePrices, type SessionGraph } from "@titan-design/session-graph";
import { runMigrations } from "@titan-design/store-sqlite";
import type { MinerConfig } from "./config.js";
import { MINER_MIGRATIONS, MINER_SCHEMA_VERSION } from "./schema.js";

export interface MinerContext extends BaseContext {
  config: MinerConfig;
  /** The open graph, created on first use so read-only commands never touch the disk needlessly. */
  graph(): SessionGraph;
  /** The rule playbook, in the same database. Strictly downstream: it never writes back to the graph. */
  playbook(): PlaybookStore;
  /** Supplied by an embedder that wants batch reflection; absent means the deterministic path only. */
  reflector?: Reflector;
  /** Set by the CLI; options that touch the local filesystem are refused on every other surface. */
  surface?: "cli";
  close(): void;
}

export interface MinerContextOptions {
  format?: BaseContext["format"];
  reflector?: Reflector;
  surface?: "cli";
}

export function createMinerContext(config: MinerConfig, options: BaseContext["format"] | MinerContextOptions = {}): MinerContext {
  const { format = "json", reflector, surface } = typeof options === "string" ? { format: options } : options;
  let graph: SessionGraph | undefined;
  let playbook: PlaybookStore | undefined;
  const ctx: MinerContext = {
    warnings: [],
    format,
    config,
    reflector,
    surface,
    graph() {
      if (!graph) {
        graph = openSessionGraph(config.dbPath, { schemaVersion: MINER_SCHEMA_VERSION });
        runMigrations(graph.db, MINER_MIGRATIONS);
        reconcilePrices(graph, PRICE_TABLE, { tableVersion: PRICE_TABLE_VERSION, source: "session-analytics" });
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
