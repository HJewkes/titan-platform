import { DEFAULT_MEMORY_TABLES } from "@titan-design/memory";
import { EXIT } from "@titan-design/registry";
import type { SessionGraph } from "@titan-design/session-graph";
import { hasTable } from "@titan-design/store-sqlite";
import type { MinerContext } from "./context.js";

/** Drain's tables from migrations 2000 and 2002; the playbook's from 2001. A session diary reads templates. */
export const DIARY_TABLES = ["template", "occurrence"];
export const DRAIN_TABLES = [...DIARY_TABLES, "clusterer_snapshot", "drain_screened"];
export const PLAYBOOK_TABLES = Object.values(DEFAULT_MEMORY_TABLES);

/** A foreign graph never ran MINER_MIGRATIONS, so the miner's own tables may be absent. */
export function hasMinerTables(graph: SessionGraph, tables: readonly string[]): boolean {
  return tables.every((table) => hasTable(graph.db, table));
}

/** Refuses a command whose tables a read-only foreign graph lacks, instead of failing on "no such table". */
export function requireMinerTables(ctx: MinerContext, command: string, tables: readonly string[]): void {
  if (hasMinerTables(ctx.graph(), tables)) return;
  const message = `${command} needs the miner's own tables, which the read-only foreign graph ${ctx.config.dbPath} does not have`;
  throw Object.assign(new Error(message), { code: EXIT.DATAERR });
}
