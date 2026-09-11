import { conversationRef } from "@titan-design/agent-protocol";
import type { Db } from "@titan-design/store-sqlite";

/** Additive: legacy rows, aliases and original locators are never rewritten. */
export const NORMALIZED_DDL = `
CREATE TABLE IF NOT EXISTS conversation (
  ref TEXT PRIMARY KEY, harness TEXT NOT NULL, namespace TEXT NOT NULL,
  native_id TEXT NOT NULL, legacy_session_id TEXT,
  UNIQUE(harness, namespace, native_id)
);
CREATE TABLE IF NOT EXISTS conversation_alias (
  legacy_ref TEXT NOT NULL, conversation_ref TEXT NOT NULL,
  PRIMARY KEY(legacy_ref, conversation_ref)
);
CREATE TABLE IF NOT EXISTS normalized_source (
  transcript_id INTEGER PRIMARY KEY, source_id TEXT NOT NULL UNIQUE,
  conversation_ref TEXT NOT NULL, descriptor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS normalized_event (
  transcript_id INTEGER NOT NULL, byte_offset INTEGER NOT NULL,
  subrecord_index INTEGER NOT NULL, byte_length INTEGER NOT NULL,
  conversation_ref TEXT NOT NULL, kind TEXT NOT NULL, ts TEXT,
  turn_ref TEXT, call_ref TEXT, item_ref TEXT, phase TEXT, is_error INTEGER,
  usage TEXT, metadata TEXT, history_origin TEXT, related_ref TEXT, relationship TEXT,
  PRIMARY KEY(transcript_id, byte_offset, subrecord_index)
);
CREATE INDEX IF NOT EXISTS idx_normalized_event_conversation ON normalized_event(conversation_ref, ts);
CREATE TABLE IF NOT EXISTS normalized_span (
  span_id INTEGER PRIMARY KEY, locators TEXT NOT NULL
);
`;

/** Only the old transcript session table proves Claude provenance, never a ref prefix. */
export function backfillClaudeAliases(db: Db, sessionIds?: readonly string[]): void {
  const insert = db.prepare("INSERT OR IGNORE INTO conversation(ref,harness,namespace,native_id,legacy_session_id) VALUES (?,?,?,?,?)");
  const alias = db.prepare("INSERT OR IGNORE INTO conversation_alias VALUES (?,?)");
  const rows = sessionIds?.map(session_id => ({ session_id })) ?? db.prepare("SELECT session_id FROM session").all() as Iterable<{ session_id: string }>;
  for (const row of rows) {
    const ref = conversationRef({ harness: "claude-code", namespace: "legacy", nativeId: row.session_id });
    insert.run(ref, "claude-code", "legacy", row.session_id, row.session_id);
    alias.run(`session:${row.session_id}`, ref);
  }
}

/** Ambiguity is explicit; workspace session bodies remain in their original namespace. */
export function resolveConversationAlias(db: Db, legacyRef: string): string | null {
  const rows = db.prepare("SELECT conversation_ref FROM conversation_alias WHERE legacy_ref = ?").all(legacyRef) as { conversation_ref: string }[];
  if (rows.length > 1) throw new Error(`ambiguous conversation alias: ${legacyRef}`);
  return rows[0]?.conversation_ref ?? null;
}
