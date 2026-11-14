import { RELATIONS } from "@titan-design/session-read";
import type { SessionGraph } from "./graph.js";
import { KIT } from "./schema.js";

/** A file to look up: a repo-relative path, in one repo or, with no repo, in any. */
export interface TouchedFileQuery {
  repo?: string | null;
  path: string;
}

export interface SessionsTouchingFilesOptions {
  files: readonly TouchedFileQuery[];
  /** ISO time; a session whose touch of the files is older is left out. */
  since: string;
  limit?: number;
}

/** Initiatives a session's task edges name, with how many edges name each. */
export interface SessionTaskInitiative {
  initiative: string;
  edges: number;
}

export interface SessionTouchingFiles {
  sessionId: string;
  /** The latest of the session's first touches of the named files. */
  touchedAt: string;
  cwd: string | null;
  title: string | null;
  /** The named files' refs this session touched. */
  fileRefs: string[];
  tasks: SessionTaskInitiative[];
}

const DEFAULT_LIMIT = 10;
const SESSION_PREFIX = "session:";

interface TouchRow {
  sessionId: string;
  touchedAt: string;
  cwd: string | null;
  title: string | null;
  fileRefs: string;
}

/** The `file` table is the small side, so a repo-less path is matched there, not by scanning edges. */
function resolveFileRefs(graph: SessionGraph, files: readonly TouchedFileQuery[]): string[] {
  const lookup = graph.db.prepare<[string, string | null, string | null], { file_ref: string }>(
    "SELECT file_ref FROM file WHERE path = ? AND (? IS NULL OR repo = ?)",
  );
  const refs = new Set<string>();
  for (const file of files) {
    const repo = file.repo ?? null;
    for (const row of lookup.all(file.path, repo, repo)) refs.add(row.file_ref);
  }
  return [...refs];
}

function readTouches(graph: SessionGraph, refs: readonly string[], options: SessionsTouchingFilesOptions): TouchRow[] {
  const sql = `
    SELECT substr(e.source_ref, ${SESSION_PREFIX.length + 1}) AS sessionId, MAX(e.t_valid) AS touchedAt,
      s.cwd AS cwd, s.ai_title AS title, json_group_array(e.target_ref) AS fileRefs
    FROM "${KIT.edge}" e LEFT JOIN session s ON s.session_id = substr(e.source_ref, ${SESSION_PREFIX.length + 1})
    WHERE e.relation = @relation AND e.t_expired IS NULL AND e.source_ref LIKE '${SESSION_PREFIX}%'
      AND e.target_ref IN (SELECT value FROM json_each(@refs))
    GROUP BY e.source_ref
    HAVING MAX(e.t_valid) >= @since
    ORDER BY touchedAt DESC, sessionId
    LIMIT @limit`;
  return graph.db.prepare<[object], TouchRow>(sql).all({
    relation: RELATIONS.TOUCHED,
    refs: JSON.stringify(refs),
    since: options.since,
    limit: options.limit ?? DEFAULT_LIMIT,
  });
}

function readTaskInitiatives(graph: SessionGraph, sessionIds: readonly string[]): Map<string, SessionTaskInitiative[]> {
  const sql = `
    SELECT substr(e.source_ref, ${SESSION_PREFIX.length + 1}) AS sessionId, t.initiative AS initiative, COUNT(*) AS edges
    FROM "${KIT.edge}" e JOIN task t ON t.task_ref = e.target_ref
    WHERE e.relation = @relation AND e.t_expired IS NULL AND t.initiative IS NOT NULL
      AND e.source_ref IN (SELECT '${SESSION_PREFIX}' || value FROM json_each(@ids))
    GROUP BY e.source_ref, t.initiative`;
  const rows = graph.db
    .prepare<[object], { sessionId: string } & SessionTaskInitiative>(sql)
    .all({ relation: RELATIONS.RAN, ids: JSON.stringify(sessionIds) });
  const bySession = new Map<string, SessionTaskInitiative[]>();
  for (const row of rows) {
    const list = bySession.get(row.sessionId) ?? [];
    list.push({ initiative: row.initiative, edges: row.edges });
    bySession.set(row.sessionId, list);
  }
  return bySession;
}

function stringArray(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
}

/**
 * Sessions that touched any of the files since a time, newest first and capped. An edge records
 * a session's first touch of a file, so a session that came back to a file later still dates from
 * its first touch. Which sessions a caller may see is the caller's policy: rows carry the cwd and
 * the initiatives their task edges name so it can decide.
 */
export function sessionsTouchingFiles(graph: SessionGraph, options: SessionsTouchingFilesOptions): SessionTouchingFiles[] {
  const refs = resolveFileRefs(graph, options.files);
  if (refs.length === 0) return [];
  const touches = readTouches(graph, refs, options);
  const tasks = readTaskInitiatives(graph, touches.map((row) => row.sessionId));
  return touches.map((row) => ({
    ...row,
    fileRefs: [...new Set(stringArray(row.fileRefs))].sort(),
    tasks: tasks.get(row.sessionId) ?? [],
  }));
}
