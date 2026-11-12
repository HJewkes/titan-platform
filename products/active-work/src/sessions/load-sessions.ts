import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { SessionFrontmatterSchema, type SessionFrontmatter } from '../schemas/session.js';

const FRONTMATTER_DELIM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** A file under `sessions/` that could not be parsed as a session. */
export interface MalformedSession {
  /** Filename including `.md`; a malformed file may have no usable identity. */
  file: string;
  reason: string;
}

/**
 * A session file that parsed. This is the single in-memory representation of a
 * session: bootstrap renders from it and derivation reasons over it, so the two
 * can never disagree about which files parsed or what they contained.
 */
export interface LoadedSession {
  /** Filename without `.md` — the identity half of a loop `ref`. */
  sessionFile: string;
  sessionId: string;
  ended: string;
  endedMs: number;
  frontmatter: SessionFrontmatter;
  /** Markdown after the frontmatter block; rendered by bootstrap. */
  body: string;
}

/** Everything one pass over `sessions/` yielded, including what it could not read. */
export interface LoadedSessions {
  sessions: LoadedSession[];
  malformed: MalformedSession[];
}

type LoadResult = { ok: true; session: LoadedSession } | { ok: false; problem: MalformedSession };

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Best-effort by contract — never throws. But an unparseable file is *not* the
 * same as an absent one: skipping it silently drops the loops it opened and
 * re-opens the ones it closed, so the reason travels back to the caller.
 */
async function loadSession(fullPath: string, sessionFile: string): Promise<LoadResult> {
  const fail = (reason: string): LoadResult => ({
    ok: false,
    problem: { file: `${sessionFile}.md`, reason },
  });
  let raw: string;
  try {
    raw = await fs.readFile(fullPath, 'utf8');
  } catch (err) {
    return fail(`unreadable: ${describe(err)}`);
  }
  const match = FRONTMATTER_DELIM.exec(raw);
  if (!match) return fail('no frontmatter block');
  let parsed: unknown;
  try {
    parsed = YAML.parse(match[1]);
  } catch (err) {
    return fail(`invalid YAML: ${describe(err)}`);
  }
  const result = SessionFrontmatterSchema.safeParse(parsed);
  if (!result.success) return fail(`invalid frontmatter: ${summarizeIssues(result.error)}`);
  return {
    ok: true,
    session: toLoadedSession(sessionFile, result.data, match[2]),
  };
}

function summarizeIssues(error: {
  issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[];
}): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join(', ');
}

function toLoadedSession(
  sessionFile: string,
  frontmatter: SessionFrontmatter,
  body: string,
): LoadedSession {
  return {
    sessionFile,
    sessionId: frontmatter.session_id,
    ended: frontmatter.ended,
    endedMs: new Date(frontmatter.ended).getTime(),
    frontmatter,
    body,
  };
}

/**
 * Read every session under `initiativeDir/sessions`, filename-ascending.
 *
 * The one loader for session files. Callers that need a different order sort a
 * copy; this order is what makes `dangling` reporting stable.
 */
export async function loadSessionsFromDir(initiativeDir: string): Promise<LoadedSessions> {
  const sessionsDir = path.join(initiativeDir, 'sessions');
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return { sessions: [], malformed: [] };
  }
  const sessions: LoadedSession[] = [];
  const malformed: MalformedSession[] = [];
  for (const filename of entries.filter((n) => n.endsWith('.md')).sort()) {
    const result = await loadSession(
      path.join(sessionsDir, filename),
      filename.slice(0, -'.md'.length),
    );
    if (result.ok) sessions.push(result.session);
    else malformed.push(result.problem);
  }
  return { sessions, malformed };
}
