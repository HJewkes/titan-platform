import { sessionRef, type TranscriptDelta } from "@titan-design/session-read";
import type { Db } from "@titan-design/store-sqlite";
import type { SessionGraph } from "./graph.js";

/**
 * Apply one transcript chunk's delta in a single transaction, so a crash can
 * never leave rows committed behind a stale watermark or ahead of their rows.
 * Append-only tables are idempotent through unique indexes; session and usage
 * rows accumulate; ref-keyed assets insert-if-absent with COALESCE merges that
 * mirror `EventFolder`'s rules.
 */
export function applyDelta(graph: SessionGraph, transcriptId: number, delta: TranscriptDelta): void {
  graph.db.transaction(() => {
    applyFacts(graph.db, transcriptId, delta);
    applySessions(graph.db, transcriptId, delta);
    applyAssets(graph.db, delta);
    applyPhases(graph.db, transcriptId, delta);
    applyLinkedRows(graph, transcriptId, delta);
  })();
}

const INSERT_FACT = `
  INSERT INTO fact (transcript_id, byte_offset, byte_length, event_type, ts, seq, session_id, prompt_id, tool_use_id)
  VALUES (@transcriptId, @byteOffset, @byteLength, @eventType, @ts, @seq, @sessionId, @promptId, @toolUseId)
  ON CONFLICT (transcript_id, byte_offset) DO NOTHING`;

/** Facts carry a per-transcript `seq` continuing from whatever is stored. */
function applyFacts(db: Db, transcriptId: number, delta: TranscriptDelta): void {
  const next = db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM fact WHERE transcript_id = ?").get(transcriptId) as { next: number };
  const insert = db.prepare(INSERT_FACT);
  let seq = next.next;
  for (const f of delta.facts) {
    insert.run({ transcriptId, byteOffset: f.byteOffset, byteLength: f.byteLength, eventType: f.eventType, ts: f.ts, seq: seq++, sessionId: f.sessionId, promptId: f.promptId, toolUseId: f.toolUseId });
  }
}

const UPSERT_SESSION = `
  INSERT INTO session (session_id, transcript_id, started_at, ended_at, start_type, cwd, git_branch, ai_title, seed_prompt, cli_version, turn_count, commit_count, push_count)
  VALUES (@sessionId, @transcriptId, @startedAt, @endedAt, @startType, @cwd, @gitBranch, @aiTitle, @seedPrompt, @cliVersion, @turnDelta, @commitDelta, @pushDelta)
  ON CONFLICT (session_id) DO UPDATE SET
    started_at  = MIN(COALESCE(started_at, excluded.started_at), COALESCE(excluded.started_at, started_at)),
    ended_at    = MAX(COALESCE(ended_at, excluded.ended_at), COALESCE(excluded.ended_at, ended_at)),
    start_type  = CASE
      WHEN excluded.start_type IS NULL THEN start_type
      WHEN start_type IS NULL THEN excluded.start_type
      WHEN COALESCE(excluded.started_at, started_at) < COALESCE(started_at, excluded.started_at) THEN excluded.start_type
      ELSE start_type END,
    cwd         = COALESCE(excluded.cwd, cwd),
    git_branch  = COALESCE(git_branch, excluded.git_branch),
    ai_title    = COALESCE(excluded.ai_title, ai_title),
    seed_prompt = COALESCE(seed_prompt, excluded.seed_prompt),
    cli_version = COALESCE(excluded.cli_version, cli_version),
    turn_count   = turn_count + excluded.turn_count,
    commit_count = commit_count + excluded.commit_count,
    push_count   = push_count + excluded.push_count`;

const UPSERT_USAGE = `
  INSERT INTO session_model_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, request_count)
  VALUES (@sessionId, @model, @inputTokens, @outputTokens, @cacheReadTokens, @cacheCreationTokens, @thinkingTokens, @requestCount)
  ON CONFLICT (session_id, model) DO UPDATE SET
    input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
    thinking_tokens = thinking_tokens + excluded.thinking_tokens, request_count = request_count + excluded.request_count`;

function applySessions(db: Db, transcriptId: number, delta: TranscriptDelta): void {
  const upsertSession = db.prepare(UPSERT_SESSION);
  for (const s of delta.sessions) upsertSession.run({ ...s, transcriptId });
  const upsertUsage = db.prepare(UPSERT_USAGE);
  for (const u of delta.usage) upsertUsage.run(u);
}

const ASSET_UPSERTS = {
  prs: `INSERT INTO pr (pr_ref, number, repo, title, url) VALUES (@prRef, @number, @repo, @title, @url)
        ON CONFLICT (pr_ref) DO UPDATE SET title = COALESCE(title, excluded.title), url = COALESCE(url, excluded.url)`,
  branches: `INSERT INTO branch (branch_ref, repo, name, base, created_at, deleted_at) VALUES (@branchRef, @repo, @name, @base, @createdAt, @deletedAt)
        ON CONFLICT (branch_ref) DO UPDATE SET base = COALESCE(base, excluded.base),
          created_at = MIN(COALESCE(created_at, excluded.created_at), COALESCE(excluded.created_at, created_at)),
          deleted_at = MAX(COALESCE(deleted_at, excluded.deleted_at), COALESCE(excluded.deleted_at, deleted_at))`,
  files: `INSERT INTO file (file_ref, repo, path) VALUES (@fileRef, @repo, @path) ON CONFLICT (file_ref) DO NOTHING`,
  tasks: `INSERT INTO task (task_ref, task_id, status) VALUES (@taskRef, @taskId, @status)
        ON CONFLICT (task_ref) DO UPDATE SET status = COALESCE(excluded.status, status)`,
  artifacts: `INSERT INTO artifact (artifact_ref, kind, title, url, path, created_at) VALUES (@artifactRef, @artifactKind, @title, @url, @path, @ts)
        ON CONFLICT (artifact_ref) DO NOTHING`,
  prMerges: `INSERT INTO pr_merge_observation (number, repo_hint, merged_at) VALUES (@number, @repoHint, @ts)
        ON CONFLICT (number, repo_hint, merged_at) DO NOTHING`,
  prCreates: `INSERT INTO pr_create_observation (tool_use_id, title, number, repo, url) VALUES (@toolUseId, @title, @number, @repo, @url)
        ON CONFLICT (tool_use_id) DO UPDATE SET title = COALESCE(title, excluded.title), number = COALESCE(number, excluded.number),
          repo = COALESCE(repo, excluded.repo), url = COALESCE(url, excluded.url)`,
} as const;

function applyAssets(db: Db, delta: TranscriptDelta): void {
  for (const [kind, sql] of Object.entries(ASSET_UPSERTS) as [keyof typeof ASSET_UPSERTS, string][]) {
    const statement = db.prepare(sql);
    for (const row of delta[kind] as unknown as Record<string, unknown>[]) statement.run(pick(row, sql));
  }
}

/** better-sqlite3 rejects unused named parameters, so pass only the ones the statement binds. */
function pick(row: Record<string, unknown>, sql: string): Record<string, unknown> {
  const names = new Set([...sql.matchAll(/@(\w+)/g)].map((m) => m[1]!));
  return Object.fromEntries([...names].map((name) => [name, row[name] ?? null]));
}

/**
 * Bi-temporal phase collapse: a candidate matching the session's open phase is a
 * no-op; otherwise the open phase closes at the new `t_valid` and a replacement
 * row is inserted. Done here so a chunk boundary mid-run cannot add a phase.
 */
function applyPhases(db: Db, transcriptId: number, delta: TranscriptDelta): void {
  const current = db.prepare("SELECT phase_id, to_mode FROM permission_phase WHERE session_id = ? AND trigger = ? AND t_invalid IS NULL ORDER BY phase_id DESC LIMIT 1");
  const close = db.prepare("UPDATE permission_phase SET t_invalid = ? WHERE phase_id = ?");
  const insert = db.prepare("INSERT INTO permission_phase (session_id, from_mode, to_mode, trigger, t_valid, fact_id) VALUES (?, ?, ?, ?, ?, ?)");
  for (const phase of delta.phases) {
    const open = current.get(phase.sessionId, phase.trigger) as { phase_id: number; to_mode: string } | undefined;
    if (open?.to_mode === phase.toMode) continue;
    if (open) close.run(phase.ts, open.phase_id);
    insert.run(phase.sessionId, open?.to_mode ?? null, phase.toMode, phase.trigger, phase.ts, factIdFor(db, transcriptId, phase.byteOffset));
  }
}

function applyLinkedRows(graph: SessionGraph, transcriptId: number, delta: TranscriptDelta): void {
  const { db } = graph;
  const factId = (byteOffset: number) => factIdFor(db, transcriptId, byteOffset);

  const upsertTurn = db.prepare(`
    INSERT INTO turn (prompt_id, session_id, turn_index, started_at, fact_id_start)
    VALUES (?, ?, (SELECT COALESCE(MAX(turn_index), -1) + 1 FROM turn WHERE session_id = ?), ?, ?)
    ON CONFLICT (prompt_id) DO UPDATE SET session_id = MIN(session_id, excluded.session_id)`);
  for (const t of delta.turns) upsertTurn.run(t.promptId, t.sessionId, t.sessionId, t.ts, factId(t.byteOffset));

  const insertEdit = db.prepare("INSERT INTO human_edit (session_id, file_path, ts, fact_id) VALUES (?, ?, ?, ?) ON CONFLICT (session_id, file_path, ts) DO NOTHING");
  for (const e of delta.humanEdits) insertEdit.run(e.sessionId, e.filePath, e.ts, factId(e.byteOffset));

  const insertCheckpoint = db.prepare(`
    INSERT INTO file_checkpoint (session_id, file_path, backup_file_name, version, backup_time, fact_id) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (session_id, file_path, backup_file_name) DO NOTHING`);
  for (const c of delta.fileCheckpoints) insertCheckpoint.run(c.sessionId, c.filePath, c.backupFileName, c.version, c.backupTime, factId(c.byteOffset));

  const upsertSubagent = db.prepare(`
    INSERT INTO subagent (agent_ref, session_id, agent_type, label, started_at, fact_id) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (agent_ref) DO UPDATE SET session_id = COALESCE(session_id, excluded.session_id),
      agent_type = COALESCE(agent_type, excluded.agent_type), label = COALESCE(label, excluded.label), started_at = COALESCE(started_at, excluded.started_at)`);
  for (const s of delta.subagents) upsertSubagent.run(s.agentRef, s.sessionId, s.agentType, s.label, s.ts || null, factId(s.byteOffset));

  // The dispatch row and this bridge come from different lines; an upsert survives a chunk boundary between them.
  const linkTranscript = db.prepare("INSERT INTO subagent (agent_ref, child_session_id) VALUES (?, ?) ON CONFLICT (agent_ref) DO UPDATE SET child_session_id = excluded.child_session_id");
  for (const l of delta.subagentTranscripts) linkTranscript.run(l.agentRef, l.childSessionId);

  for (const e of delta.edges) graph.edges.assert({ sourceRef: e.sourceRef, relation: e.relation, targetRef: e.targetRef, tValid: e.ts, factId: factId(e.byteOffset) });

  for (const span of delta.spans) {
    graph.spans.index({ ownerRef: sessionRef(span.sessionId), field: span.field, sourceId: transcriptId, byteOffset: span.byteOffset, byteLength: span.byteLength }, span.text);
  }
}

function factIdFor(db: Db, transcriptId: number, byteOffset: number): number | null {
  const row = db.prepare("SELECT fact_id FROM fact WHERE transcript_id = ? AND byte_offset = ?").get(transcriptId, byteOffset) as { fact_id: number } | undefined;
  return row?.fact_id ?? null;
}
