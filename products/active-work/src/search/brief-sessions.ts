import { existsSync } from 'node:fs';
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
import type { RelatedDegradation } from './related.js';

/**
 * The spawn brief's recent-sessions section (TP-5453 P11b): sessions that touched the files the
 * assignment names, in the last two weeks. A session is listed only when it maps to an initiative
 * the agent view shows, so one in an owner-only initiative, or in none, never reaches a spawn.
 */

const SESSIONS_SHARE_BYTES = 500;
const SESSION_LINES = 4;
/** Read past the line cap, since rows the agent view withholds are dropped after the read. */
const SESSION_CANDIDATES = 20;
const WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;
const TITLE_MAX = 60;
const ID_CHARS = 8;
const NAMED_FILES_MAX = 20;
const HEADING = '## Recent sessions on the named files\n\n';
const SECTION_GAP = '\n\n';
const ACTIVE_WORK_CWD = 'active-work:';

/** Repo-relative paths only: a path after a `/`, `~` or `://` is absolute or a URL and is skipped. */
const NAMED_FILE = /(?<![\w./~-])(?:[\w.-]+\/)+[\w-][\w.-]*\.[A-Za-z0-9]+(?![\w/])/g;

interface BriefSessionsInput {
  text: string;
  activeRoot: string;
  now: Date;
  dbPath?: string;
}

export interface BriefSessions {
  lines: string[];
  degraded: RelatedDegradation[];
}

function namedFiles(text: string): TouchedFileQuery[] {
  const paths = new Set(Array.from(text.matchAll(NAMED_FILE), (match) => match[0]));
  return [...paths].slice(0, NAMED_FILES_MAX).map((filePath) => ({ path: filePath }));
}

/** A task edge names the initiative outright; otherwise only a cwd inside the active root does. */
function initiativeOf(row: SessionTouchingFiles): string | null {
  const key = sessionInitiative(row.tasks, row.cwd);
  if (row.tasks.length > 0) return key;
  return key.startsWith(ACTIVE_WORK_CWD) ? key.slice(ACTIVE_WORK_CWD.length) : null;
}

function bounded(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

function sessionLine(row: SessionTouchingFiles): string {
  const title = bounded((row.title ?? '(untitled)').replace(/\s+/g, ' ').trim(), TITLE_MAX);
  return `- ${row.sessionId.slice(0, ID_CHARS)} ${row.touchedAt.slice(0, 10)} ${title}`;
}

function readVisible(input: BriefSessionsInput, files: TouchedFileQuery[], shown: Shown): string[] {
  const graph = openSessionGraph(input.dbPath ?? defaultGraphPath(), { readonly: true });
  try {
    const since = new Date(input.now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
    return sessionsTouchingFiles(graph, { files, since, limit: SESSION_CANDIDATES })
      .filter((row) => shown(initiativeOf(row)))
      .slice(0, SESSION_LINES)
      .map(sessionLine);
  } finally {
    graph.db.close();
  }
}

/** Always the agent view: `/rpc` runs every caller as the owner, so no caller is consulted. */
export async function briefSessions(input: BriefSessionsInput): Promise<BriefSessions> {
  const files = namedFiles(input.text);
  if (files.length === 0) return { lines: [], degraded: [] };
  const dbPath = input.dbPath ?? defaultGraphPath();
  if (!existsSync(dbPath)) {
    return { lines: [], degraded: [{ source: 'sessions', reason: 'missing', message: `no index at ${dbPath}` }] };
  }
  const shown = await visibilityFor({ activeRoot: input.activeRoot, warnings: [] });
  try {
    return { lines: readVisible({ ...input, dbPath }, files, shown), degraded: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { lines: [], degraded: [{ source: 'sessions', reason: 'error', message }] };
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
  return { ...block, text, bytes: utf8Bytes(text) };
}
