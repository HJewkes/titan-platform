import type { TranscriptDelta } from "@titan-design/session-read";
import type { Db } from "@titan-design/store-sqlite";

type Row = Record<string, unknown>;

/**
 * One API response is written as several assistant lines, each repeating its
 * usage. The row keeps the first line's identity and the largest count seen,
 * so a partial streaming copy never wins and chunk order cannot change it.
 */
const UPSERT_REQUEST = `
  INSERT INTO request (transcript_id, request_id, byte_offset, session_id, message_id, ts, model,
    input_tokens, cache_read_tokens, cache_creation_tokens, cache_creation_5m, cache_creation_1h,
    output_tokens, thinking_tokens, context_tokens, service_tier, is_sidechain)
  VALUES (@transcriptId, @requestId, @byteOffset, @sessionId, @messageId, @ts, @model,
    @inputTokens, @cacheReadTokens, @cacheCreationTokens, @cacheCreation5mTokens, @cacheCreation1hTokens,
    @outputTokens, @thinkingTokens, @inputTokens + @cacheReadTokens + @cacheCreationTokens, @serviceTier, @isSidechain)
  ON CONFLICT (transcript_id, request_id) DO UPDATE SET
    session_id   = CASE WHEN excluded.byte_offset < byte_offset THEN excluded.session_id ELSE session_id END,
    message_id   = CASE WHEN excluded.byte_offset < byte_offset THEN excluded.message_id ELSE message_id END,
    model        = CASE WHEN excluded.byte_offset < byte_offset THEN excluded.model ELSE model END,
    service_tier = CASE WHEN excluded.byte_offset < byte_offset THEN excluded.service_tier ELSE service_tier END,
    is_sidechain = CASE WHEN excluded.byte_offset < byte_offset THEN excluded.is_sidechain ELSE is_sidechain END,
    byte_offset  = MIN(byte_offset, excluded.byte_offset),
    ts           = MIN(ts, excluded.ts),
    input_tokens          = MAX(input_tokens, excluded.input_tokens),
    cache_read_tokens     = MAX(cache_read_tokens, excluded.cache_read_tokens),
    cache_creation_tokens = MAX(cache_creation_tokens, excluded.cache_creation_tokens),
    cache_creation_5m     = MAX(cache_creation_5m, excluded.cache_creation_5m),
    cache_creation_1h     = MAX(cache_creation_1h, excluded.cache_creation_1h),
    output_tokens         = MAX(output_tokens, excluded.output_tokens),
    thinking_tokens       = MAX(thinking_tokens, excluded.thinking_tokens),
    context_tokens        = MAX(input_tokens, excluded.input_tokens) + MAX(cache_read_tokens, excluded.cache_read_tokens)
                          + MAX(cache_creation_tokens, excluded.cache_creation_tokens)`;

/** Line-located rows are facts about one position in the file, so a re-read of the same bytes is a no-op. */
const INSERTS = {
  toolCalls: `INSERT INTO tool_call (transcript_id, byte_offset, block_index, session_id, ts, tool_use_id, name, family, mcp_server, input_chars)
    VALUES (@transcriptId, @byteOffset, @blockIndex, @sessionId, @ts, @toolUseId, @name, @family, @mcpServer, @inputChars)
    ON CONFLICT DO NOTHING`,
  inbound: `INSERT INTO inbound (transcript_id, byte_offset, block_index, session_id, ts, cause, delivery, detail, origin_server, from_name, msg_id, tool_use_id, is_error, content_hash, chars)
    VALUES (@transcriptId, @byteOffset, @blockIndex, @sessionId, @ts, @cause, @delivery, @detail, @originServer, @fromName, @msgId, @toolUseId, @isError, @contentHash, @chars)
    ON CONFLICT DO NOTHING`,
  contextBlocks: `INSERT INTO context_block (transcript_id, byte_offset, block_index, session_id, ts, source, tool_use_id, attachment_type, chars, is_media)
    VALUES (@transcriptId, @byteOffset, @blockIndex, @sessionId, @ts, @source, @toolUseId, @attachmentType, @chars, @isMedia)
    ON CONFLICT DO NOTHING`,
  compactions: `INSERT INTO compaction (transcript_id, byte_offset, session_id, ts, trigger, pre_tokens, post_tokens, dropped_tokens, duration_ms)
    VALUES (@transcriptId, @byteOffset, @sessionId, @ts, @trigger, @preTokens, @postTokens, @droppedTokens, @durationMs)
    ON CONFLICT DO NOTHING`,
  queueOps: `INSERT INTO queue_op (transcript_id, byte_offset, session_id, ts, operation, content_hash, origin_server)
    VALUES (@transcriptId, @byteOffset, @sessionId, @ts, @operation, @contentHash, @originServer)
    ON CONFLICT DO NOTHING`,
  signals: `INSERT INTO session_signal (transcript_id, byte_offset, block_index, session_id, ts, signal, detail, tool_use_id)
    VALUES (@transcriptId, @byteOffset, @blockIndex, @sessionId, @ts, @signal, @detail, @toolUseId)
    ON CONFLICT DO NOTHING`,
  costStates: `INSERT INTO cost_state_observation (transcript_id, byte_offset, session_id, ts, total_cost_usd, model_usage)
    VALUES (@transcriptId, @byteOffset, @sessionId, @ts, @totalCostUsd, @modelUsageJson)
    ON CONFLICT DO NOTHING`,
} as const;

/** Write one delta's audit events. Runs inside `applyDelta`'s transaction, so it opens none of its own. */
export function applyAudit(db: Db, transcriptId: number, delta: TranscriptDelta): void {
  run(db, UPSERT_REQUEST, transcriptId, delta.requests);
  for (const [list, sql] of Object.entries(INSERTS) as [keyof typeof INSERTS, string][]) {
    run(db, sql, transcriptId, delta[list]);
  }
}

function run(db: Db, sql: string, transcriptId: number, events: readonly object[]): void {
  if (events.length === 0) return;
  const statement = db.prepare(sql);
  const names = [...new Set([...sql.matchAll(/@(\w+)/g)].map((m) => m[1]!))];
  for (const event of events) statement.run(bind(names, { ...(event as Row), transcriptId }));
}

/** better-sqlite3 rejects unused named parameters and cannot bind booleans. */
function bind(names: readonly string[], row: Row): Row {
  return Object.fromEntries(names.map((name) => {
    const value = row[name] ?? null;
    return [name, typeof value === "boolean" ? Number(value) : value];
  }));
}
