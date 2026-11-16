import { existsSync } from 'node:fs';
import path from 'node:path';
import { sessionInitiative } from '@titan-design/session-analytics';
import {
  openSessionGraph,
  sessionsTouchingFiles,
  type SessionTouchingFiles,
  type TouchedFileQuery,
} from '@titan-design/session-graph';
import { defaultGraphPath } from '../session-index/graph.js';
import { visibilityFor, type Shown } from '../sessions/visibility.js';
import { utf8Bytes, type BriefBlock } from './brief-block.js';
import { namedFiles } from './brief-task-files.js';
import type { RelatedDegradation } from './related.js';

/**
 * The spawn brief's recent-sessions section (TP-5453 P11b): sessions that touched the files the
 * assignment names, in the last two weeks. A session is listed only when every initiative its task
 * edges name is one the agent view shows (or, with no task edges, its cwd's initiative is), so one
 * that touched an owner-only initiative at all, or maps to none, never reaches a spawn.
 */

const SESSIONS_SHARE_BYTES = 500;
const SESSION_LINES = 4;
/** Read past the line cap, since rows the agent view withholds are dropped after the read. */
const SESSION_CANDIDATES = 20;
const WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;
const TITLE_MAX = 60;
const ID_CHARS = 8;
const HEADING = '## Recent sessions on the named files\n\n';
const SECTION_GAP = '\n\n';

interface BriefSessionsInput {
  text: string;
  activeRoot: string;
  now: Date;
  dbPath?: string;
}

export interface BriefSessions {
  lines: string[];
  /** The full session id each line names, in line order. */
  refs: string[];
  degraded: RelatedDegradation[];
}

type SessionRow = Pick<SessionTouchingFiles, 'tasks' | 'cwd'>;

/** The initiative folder a cwd sits in under the configured active root, whatever that root is named. */
function cwdInitiative(cwd: string | null, activeRoot: string): string | null {
  if (!cwd) return null;
  const relative = path.relative(path.resolve(activeRoot), path.resolve(cwd));
  if (relative === '' || path.isAbsolute(relative)) return null;
  const first = relative.split(path.sep)[0];
  return first === '..' ? null : first;
}

/** A task edge names the initiative outright; otherwise only a cwd inside the active root does. */
export function initiativeOf(row: SessionRow, activeRoot: string): string | null {
  if (row.tasks.length > 0) return sessionInitiative(row.tasks, row.cwd);
  return cwdInitiative(row.cwd, activeRoot);
}

/** Every initiative a task edge names must be shown: one owner-only edge withholds the whole row. */
function sessionShown(row: SessionRow, activeRoot: string, shown: Shown): boolean {
  if (row.tasks.length > 0) return row.tasks.every((task) => shown(task.initiative));
  return shown(cwdInitiative(row.cwd, activeRoot));
}

function bounded(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

function sessionLine(row: SessionTouchingFiles): string {
  const title = bounded((row.title ?? '(untitled)').replace(/\s+/g, ' ').trim(), TITLE_MAX);
  return `- ${row.sessionId.slice(0, ID_CHARS)} ${row.touchedAt.slice(0, 10)} ${title}`;
}

function readVisible(
  input: BriefSessionsInput,
  files: TouchedFileQuery[],
  shown: Shown,
): Pick<BriefSessions, 'lines' | 'refs'> {
  const graph = openSessionGraph(input.dbPath ?? defaultGraphPath(), { readonly: true });
  try {
    const since = new Date(input.now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
    const rows = sessionsTouchingFiles(graph, { files, since, limit: SESSION_CANDIDATES })
      .filter((row) => sessionShown(row, input.activeRoot, shown))
      .slice(0, SESSION_LINES);
    return { lines: rows.map(sessionLine), refs: rows.map((row) => row.sessionId) };
  } finally {
    graph.db.close();
  }
}

/** Always the agent view: `/rpc` runs every caller as the owner, so no caller is consulted. */
export async function briefSessions(input: BriefSessionsInput): Promise<BriefSessions> {
  const files: TouchedFileQuery[] = namedFiles(input.text).map((filePath) => ({ path: filePath }));
  if (files.length === 0) return { lines: [], refs: [], degraded: [] };
  const dbPath = input.dbPath ?? defaultGraphPath();
  if (!existsSync(dbPath)) {
    const missing = { source: 'sessions', reason: 'missing', message: `no index at ${dbPath}` };
    return { lines: [], refs: [], degraded: [missing] };
  }
  const shown = await visibilityFor({ activeRoot: input.activeRoot, warnings: [] });
  try {
    return { ...readVisible({ ...input, dbPath }, files, shown), degraded: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { lines: [], refs: [], degraded: [{ source: 'sessions', reason: 'error', message }] };
  }
}

/** The section goes after the workspace block, inside its own share and whatever budget is left. */
export function withSessions(block: BriefBlock, sessions: BriefSessions, budgetBytes: number): BriefBlock {
  const gap = block.text === '' ? '' : SECTION_GAP;
  const share = Math.min(SESSIONS_SHARE_BYTES, budgetBytes - block.bytes - utf8Bytes(gap));
  const fitted: string[] = [];
  let used = utf8Bytes(HEADING);
  for (const line of sessions.lines) {
    const cost = utf8Bytes(line) + (fitted.length === 0 ? 0 : 1);
    if (used + cost > share) break;
    fitted.push(line);
    used += cost;
  }
  if (fitted.length === 0) return block;
  const text = `${block.text}${gap}${HEADING}${fitted.join('\n')}`;
  const refs = sessions.refs.slice(0, fitted.length).map((ref) => ({ ref, source: 'sessions' as const }));
  return { ...block, text, refs: [...block.refs, ...refs], bytes: utf8Bytes(text) };
}
