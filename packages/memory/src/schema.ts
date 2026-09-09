import { SQL_NOW, kitDdl, quoteIdent, type Migration } from "@titan-design/store-sqlite";

/**
 * Four kit tables plus one domain table. Bullets are interval entities, the
 * `supersedes` relation lives in the edge table, embeddings in cache_blob keyed
 * by content hash, and per-session progress in the watermark table.
 */
export interface MemoryTables {
  entity: string;
  edge: string;
  cacheBlob: string;
  watermark: string;
  feedback: string;
}

export const DEFAULT_MEMORY_TABLES: MemoryTables = {
  entity: "memory_entity",
  edge: "memory_edge",
  cacheBlob: "memory_cache",
  watermark: "memory_watermark",
  feedback: "memory_feedback",
};

export const BULLET_KIND = "bullet";
export const BLOCKED_KIND = "blocked";
export const SUPERSEDES = "supersedes";

export function feedbackTableDdl(name: string = DEFAULT_MEMORY_TABLES.feedback): string {
  const t = quoteIdent(name);
  return `
    CREATE TABLE IF NOT EXISTS ${t} (
      id          INTEGER PRIMARY KEY,
      bullet_ref  TEXT NOT NULL,
      type        TEXT NOT NULL,
      at          TEXT NOT NULL DEFAULT (${SQL_NOW}),
      session_ref TEXT,
      reason      TEXT
    );
    CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${name}_bullet`)} ON ${t}(bullet_ref, at);
  `;
}

export function memoryDdl(tables: MemoryTables = DEFAULT_MEMORY_TABLES): string {
  const kit = kitDdl({ entity: tables.entity, edge: tables.edge, cacheBlob: tables.cacheBlob, watermark: tables.watermark });
  return `${kit}\n${feedbackTableDdl(tables.feedback)}`;
}

/** Drop into a product's migration list so the playbook shares its database. */
export function memoryMigration(version: number, tables: MemoryTables = DEFAULT_MEMORY_TABLES): Migration {
  return { version, name: `memory:${tables.entity}`, up: (db) => db.exec(memoryDdl(tables)) };
}
