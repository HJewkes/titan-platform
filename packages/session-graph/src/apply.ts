import { applyAudit, namedBinder } from "./audit-apply.js";
import { ECHO_STATE_TABLE } from "./echo-state-schema.js";
import { REVIEW_TABLE } from "./review-schema.js";
import { isUntypedPrompt, stripInjected } from "./injected-text.js";
import { backfillClaudeAliases } from "./normalized-schema.js";
import { RELATIONS, sessionRef, type TranscriptDelta } from "@titan-design/session-read";
import type { Db, EdgeInput } from "@titan-design/store-sqlite";
import type { SessionGraph } from "./graph.js";

/**
 * Apply one transcript chunk's delta in a single transaction, so a crash can
 * never leave rows committed behind a stale watermark or ahead of their rows.
 * Append-only tables are idempotent through unique indexes; session rows
 * accumulate; usage is left to the rollup, which recomputes it from `request`;
 * ref-keyed assets insert-if-absent with COALESCE merges that mirror
 * `EventFolder`'s rules.
 */
export function applyDelta(graph: SessionGraph, transcriptId: number, delta: TranscriptDelta, source: DeltaSource = {}): void {
  graph.db.transaction(() => {
    for (const step of deltaSteps(graph, transcriptId, delta, source)) step();
  })();
}

/**
 * `applyDelta` with `yieldPoint` awaited between bounded steps, all inside one
 * transaction held open across the yields, so the delta still commits or rolls
 * back whole. One transcript's delta held the loop 95 to 148 ms locally and
 * about 2.6 s on a loaded CI runner (TP-4175). Rows written so far are visible
 * on this connection during a yield; the refresh lock keeps other writers out.
 * Inside a caller's transaction it runs in one go, as a savepoint cannot span a yield safely.
 */
export async function applyDeltaYielding(graph: SessionGraph, transcriptId: number, delta: TranscriptDelta, source: DeltaSource, yieldPoint: () => Promise<void>): Promise<void> {
  if (graph.db.inTransaction) return applyDelta(graph, transcriptId, delta, source);
  graph.db.exec("BEGIN");
  try {
    for (const step of deltaSteps(graph, transcriptId, delta, source)) {
      step();
      await yieldPoint();
    }
    graph.db.exec("COMMIT");
  } catch (err) {
    rollbackIfOpen(graph.db);
    throw err;
  }
}

/** A failed COMMIT may already have rolled back on its own. */
function rollbackIfOpen(db: Db): void {
  if (db.inTransaction) db.exec("ROLLBACK");
}

/** Rows per step. Each list is applied in order, so slicing it changes no row: every statement reads what the slices before it wrote. */
const STEP_ROWS = 500;

function slices<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += STEP_ROWS) out.push(rows.slice(i, i + STEP_ROWS));
  return out;
}

const LINKED_KEYS = ["turns", "humanEdits", "fileCheckpoints", "subagents", "subagentTranscripts", "edges"] as const;
type LinkedRows = Pick<TranscriptDelta, (typeof LINKED_KEYS)[number]>;
const NO_LINKED_ROWS: LinkedRows = { turns: [], humanEdits: [], fileCheckpoints: [], subagents: [], subagentTranscripts: [], edges: [] };

/** Facts first, since every later step resolves its `fact_id` from them. */
function* deltaSteps(graph: SessionGraph, transcriptId: number, delta: TranscriptDelta, source: DeltaSource): Generator<() => void> {
  const { db } = graph;
  for (const facts of slices(delta.facts)) yield () => applyFacts(db, transcriptId, facts);
  yield () => {
    applySessions(db, transcriptId, delta, source.account ?? null);
    backfillClaudeAliases(db, delta.sessions.map(s => s.sessionId));
    applyAssets(db, delta);
    applyPhases(db, transcriptId, delta);
  };
  for (const key of LINKED_KEYS) {
    for (const rows of slices<unknown>(delta[key])) yield () => applyLinkedRows(graph, transcriptId, { ...NO_LINKED_ROWS, [key]: rows });
  }
  const injectedLines = new Set(delta.inbound.filter(i => isUntypedPrompt(i, source.indexSdkPrompts ?? false)).map(i => i.byteOffset));
  for (const spans of slices(delta.spans)) yield () => applySpans(graph, transcriptId, spans, injectedLines);
  yield () => {
    applyReviewVerdicts(db, transcriptId, delta);
    applyAudit(db, transcriptId, delta);
  };
}

/** What discovery knows about the file that the lines themselves do not carry. */
export interface DeltaSource {
  /** The Claude config dir the transcript was found under; `null` when discovery did not say. */
  account?: string | null;
  /** Index prompts the host labels `promptSource: "sdk"` (spawned agents and `claude -p`). Off by default; see README "Injected context". */
  indexSdkPrompts?: boolean;
}

const INSERT_FACT = `
  INSERT INTO fact (transcript_id, byte_offset, byte_length, event_type, ts, seq, session_id, prompt_id, tool_use_id)
  VALUES (@transcriptId, @byteOffset, @byteLength, @eventType, @ts, @seq, @sessionId, @promptId, @toolUseId)
  ON CONFLICT (transcript_id, byte_offset) DO NOTHING`;

const READ_ECHO = `SELECT value FROM ${ECHO_STATE_TABLE} WHERE transcript_id = ? AND session_id = ? AND key = ?`;
const UPSERT_ECHO = `
  INSERT INTO ${ECHO_STATE_TABLE} (transcript_id, session_id, key, value) VALUES (?, ?, ?, ?)
  ON CONFLICT (transcript_id, session_id, key) DO UPDATE SET value = excluded.value`;

/**
 * Facts carry a per-transcript `seq` continuing from whatever is stored. An echo fact whose value
 * equals the stored state is skipped without taking a `seq`; the state lives in a table rather
 * than in memory, so a chunked read keeps exactly the facts a whole-file read keeps.
 */
function applyFacts(db: Db, transcriptId: number, facts: TranscriptDelta["facts"]): void {
  const next = db.prepare<[number], { next: number }>("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM fact WHERE transcript_id = ?").get(transcriptId);
  const insert = db.prepare(INSERT_FACT);
  const readEcho = db.prepare<[number, string, string], { value: string }>(READ_ECHO);
  const upsertEcho = db.prepare(UPSERT_ECHO);
  let seq = next?.next ?? 0;
  for (const f of facts) {
    if (f.state) {
      const stored = readEcho.get(transcriptId, f.sessionId, f.state.key);
      if (stored?.value === f.state.value) continue;
      upsertEcho.run(transcriptId, f.sessionId, f.state.key, f.state.value);
    }
    insert.run({ transcriptId, byteOffset: f.byteOffset, byteLength: f.byteLength, eventType: f.eventType, ts: f.ts, seq: seq++, sessionId: f.sessionId, promptId: f.promptId, toolUseId: f.toolUseId });
  }
}

const UPSERT_SESSION = `
  INSERT INTO session (session_id, transcript_id, started_at, ended_at, start_type, cwd, git_branch, ai_title, seed_prompt, cli_version, account, turn_count, commit_count, push_count)
  VALUES (@sessionId, @transcriptId, @startedAt, @endedAt, @startType, @cwd, @gitBranch, @aiTitle, @seedPrompt, @cliVersion, @account, @turnDelta, @commitDelta, @pushDelta)
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
    account     = COALESCE(excluded.account, account),
    turn_count   = turn_count + excluded.turn_count,
    commit_count = commit_count + excluded.commit_count,
    push_count   = push_count + excluded.push_count`;

function applySessions(db: Db, transcriptId: number, delta: TranscriptDelta, account: string | null): void {
  const upsertSession = db.prepare(UPSERT_SESSION);
  for (const s of delta.sessions) upsertSession.run({ ...s, transcriptId, account });
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
  prMerges: `INSERT INTO pr_merge_observation (number, repo_hint, merged_at) VALUES (@number, @repoHint, @ts)
        ON CONFLICT (number, repo_hint, merged_at) DO NOTHING`,
  prCreates: `INSERT INTO pr_create_observation (tool_use_id, title, number, repo, url) VALUES (@toolUseId, @title, @number, @repo, @url)
        ON CONFLICT (tool_use_id) DO UPDATE SET title = COALESCE(title, excluded.title), number = COALESCE(number, excluded.number),
          repo = COALESCE(repo, excluded.repo), url = COALESCE(url, excluded.url)`,
} as const;

const ASSET_KINDS = ["prs", "branches", "files", "tasks", "prMerges", "prCreates"] as const satisfies readonly (keyof typeof ASSET_UPSERTS)[];

function applyAssets(db: Db, delta: TranscriptDelta): void {
  for (const kind of ASSET_KINDS) {
    const sql = ASSET_UPSERTS[kind];
    const statement = db.prepare(sql);
    const bind = namedBinder(sql);
    for (const row of delta[kind]) statement.run(bind({ ...row }));
  }
}

/** A re-read refreshes the parsed fields and keeps a resolved `pr_ref`. */
const UPSERT_CHAT_VERDICT = `
  INSERT INTO ${REVIEW_TABLE} (source_key, surface, verdict, ts, session_id, transcript_id, repo, repo_hint, cwd_repo, number)
  VALUES (@sourceKey, 'chat', @verdict, @ts, @sessionId, @transcriptId, @repo, @repoHint, @cwdRepo, @number)
  ON CONFLICT (source_key) DO UPDATE SET verdict = excluded.verdict, ts = excluded.ts, session_id = excluded.session_id,
    transcript_id = excluded.transcript_id, repo = excluded.repo, repo_hint = excluded.repo_hint,
    cwd_repo = excluded.cwd_repo, number = excluded.number`;

/** The ordinal comes from the event, so one tool use's verdicts keep distinct keys across chunk boundaries. */
function applyReviewVerdicts(db: Db, transcriptId: number, delta: TranscriptDelta): void {
  const upsert = db.prepare(UPSERT_CHAT_VERDICT);
  const keys = chatVerdictKeys(delta.reviewVerdicts);
  delta.reviewVerdicts.forEach((v, i) => {
    upsert.run({
      sourceKey: keys[i], verdict: v.verdict, ts: v.ts, sessionId: v.sessionId, transcriptId,
      repo: v.repo, repoHint: v.repoHint, cwdRepo: v.cwdRepo, number: v.number,
    });
  });
}

type ChatVerdict = TranscriptDelta["reviewVerdicts"][number];

const hasOrdinal = (v: ChatVerdict): boolean => Number.isInteger(v.ordinal) && v.ordinal >= 0;

/**
 * A session-read that predates `ordinal` sends none, so those verdicts take the next index
 * this call has not used for their tool use, skipping any ordinal another event carries.
 * Per call is enough because that session-read emits all of one tool use's verdicts from one line.
 */
function chatVerdictKeys(verdicts: readonly ChatVerdict[]): string[] {
  const used = new Map<string, Set<number>>();
  const usedBy = (id: string) => used.get(id) ?? used.set(id, new Set()).get(id)!;
  for (const v of verdicts) if (hasOrdinal(v)) usedBy(v.toolUseId).add(v.ordinal);
  return verdicts.map((v) => {
    if (hasOrdinal(v)) return `chat:${v.toolUseId}:${v.ordinal}`;
    const taken = usedBy(v.toolUseId);
    let n = 0;
    while (taken.has(n)) n += 1;
    taken.add(n);
    return `chat:${v.toolUseId}:${n}`;
  });
}

/**
 * Bi-temporal phase collapse: a candidate matching the session's open phase is a
 * no-op; otherwise the open phase closes at the new `t_valid` and a replacement
 * row is inserted. Done here so a chunk boundary mid-run cannot add a phase.
 */
function applyPhases(db: Db, transcriptId: number, delta: TranscriptDelta): void {
  const current = db.prepare<[string, string], { phase_id: number; to_mode: string }>("SELECT phase_id, to_mode FROM permission_phase WHERE session_id = ? AND trigger = ? AND t_invalid IS NULL ORDER BY phase_id DESC LIMIT 1");
  const close = db.prepare("UPDATE permission_phase SET t_invalid = ? WHERE phase_id = ?");
  const insert = db.prepare("INSERT INTO permission_phase (session_id, from_mode, to_mode, trigger, t_valid, fact_id) VALUES (?, ?, ?, ?, ?, ?)");
  for (const phase of delta.phases) {
    const open = current.get(phase.sessionId, phase.trigger);
    if (open?.to_mode === phase.toMode) continue;
    if (open) close.run(phase.ts, open.phase_id);
    insert.run(phase.sessionId, open?.to_mode ?? null, phase.toMode, phase.trigger, phase.ts, factIdFor(db, transcriptId, phase.byteOffset));
  }
}

function applyLinkedRows(graph: SessionGraph, transcriptId: number, delta: LinkedRows): void {
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

  for (const e of delta.edges) assertTranscriptEdge(graph, { sourceRef: e.sourceRef, relation: e.relation, targetRef: e.targetRef, tValid: e.ts, factId: factId(e.byteOffset) });
}

/** Prompt spans index only what the human typed; a line nobody typed indexes no prompt at all. */
function applySpans(graph: SessionGraph, transcriptId: number, spans: TranscriptDelta["spans"], injectedLines: ReadonlySet<number>): void {
  for (const span of spans) {
    const isPrompt = span.field === "prompt";
    const text = !isPrompt ? span.text : injectedLines.has(span.byteOffset) ? "" : stripInjected(span.text);
    if (isPrompt && !text) continue;
    graph.spans.index({ ownerRef: sessionRef(span.sessionId), field: span.field, sourceId: transcriptId, byteOffset: span.byteOffset, byteLength: span.byteLength }, text);
  }
}

/**
 * A transcript's `ran` claim outranks a spawn record's: an origin-made edge for the same
 * task is superseded without `via`, so origin expiry cannot later remove it.
 */
function assertTranscriptEdge(graph: SessionGraph, edge: EdgeInput): void {
  const existing = edge.relation === RELATIONS.RAN ? graph.edges.current(edge.sourceRef, edge.relation, edge.targetRef) : undefined;
  if (existing?.attrs?.via === "origin") graph.edges.supersede(edge);
  else graph.edges.assert(edge);
}

function factIdFor(db: Db, transcriptId: number, byteOffset: number): number | null {
  const row = db.prepare<[number, number], { fact_id: number }>("SELECT fact_id FROM fact WHERE transcript_id = ? AND byte_offset = ?").get(transcriptId, byteOffset);
  return row?.fact_id ?? null;
}
