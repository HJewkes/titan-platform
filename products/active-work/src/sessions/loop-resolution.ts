import type { NextStep } from '../schemas/session.js';
import {
  loadSessionsFromDir,
  type LoadedSession,
  type LoadedSessions,
  type MalformedSession,
} from './load-sessions.js';

/**
 * Why a `resolves` entry did not close a loop. The kinds have different
 * remedies, so they must not be conflated: `missing` is a bad ref, `not-prior`
 * is a correct ref filed too early (re-file it from a later session), `self` is
 * a session trying to close its own loop.
 */
export type DanglingKind = 'missing' | 'not-prior' | 'self';

export interface DanglingResolve {
  /** Stem of the session file that recorded the bad `resolves` entry. */
  sessionFile: string;
  ref: string;
  kind: DanglingKind;
}

interface SessionIssues {
  dangling: DanglingResolve[];
  malformed: MalformedSession[];
}

export interface LoopEntry {
  ref: string;
  step: NextStep;
  session: LoadedSession;
}

/** How one loop was closed, carried through derivation instead of discarded. */
export interface Resolution {
  outcome: 'done' | 'abandoned';
  note?: string;
  closedBy: string;
  closedAt: string;
  /** `closedAt` as an instant. Ordering must never compare the raw strings. */
  closedAtMs: number;
}

interface Analysis {
  loops: LoopEntry[];
  resolutions: Map<string, Resolution>;
  dangling: DanglingResolve[];
  malformed: MalformedSession[];
}

function indexLoops(sessions: LoadedSession[]): Map<string, LoopEntry> {
  const loops = new Map<string, LoopEntry>();
  for (const session of sessions) {
    for (const step of session.frontmatter.next_steps) {
      // Filename stems are unique by construction, so no ref can collide.
      loops.set(`${session.sessionFile}#${step.id}`, {
        ref: `${session.sessionFile}#${step.id}`,
        step,
        session,
      });
    }
  }
  return loops;
}

function refStem(ref: string): string {
  const hash = ref.indexOf('#');
  return hash < 0 ? ref : ref.slice(0, hash);
}

/**
 * Classify one `resolves` entry, returning null when it legitimately closes.
 *
 * Only a *strictly* earlier session may close a loop. `<=` let a session close
 * its own loop (defeating the empty-ledger gate) and let two sessions sharing
 * an `ended` close each other's loops in a cycle, both silently.
 *
 * Same-`session_id` targets are rejected too: `pickAvailableFilename` parks a
 * colliding record at `<stem>-1.md`, so a self-directed resolve lands on the
 * *earlier* file and would silently close a different record's live loop.
 */
function classifyResolve(
  ref: string,
  session: LoadedSession,
  loops: Map<string, LoopEntry>,
): DanglingKind | null {
  if (refStem(ref) === session.sessionFile) return 'self';
  const target = loops.get(ref);
  if (!target) return 'missing';
  if (target.session.sessionId === session.sessionId) return 'self';
  if (target.session.endedMs >= session.endedMs) return 'not-prior';
  return null;
}

/**
 * Later resolutions win. Two sessions may both close one loop — the ledger
 * permits it — and the most recent statement of outcome is the current one.
 *
 * "Most recent" is compared as an instant, never as the raw `ended` string:
 * `iso8601` accepts any timezone offset, so `2026-05-12T02:00:00-07:00` and
 * `2026-05-12T09:00:00Z` are the same moment while sorting seven hours apart
 * lexicographically. Comparing strings picks the wrong outcome for exactly the
 * distinction this carries — done versus abandoned.
 */
function applyResolves(
  sessions: LoadedSession[],
  loops: Map<string, LoopEntry>,
): { resolutions: Map<string, Resolution>; dangling: DanglingResolve[] } {
  const resolutions = new Map<string, Resolution>();
  const dangling: DanglingResolve[] = [];
  for (const session of sessions) {
    for (const entry of session.frontmatter.resolves) {
      const kind = classifyResolve(entry.ref, session, loops);
      if (kind !== null) {
        dangling.push({
          sessionFile: session.sessionFile,
          ref: entry.ref,
          kind,
        });
        continue;
      }
      const existing = resolutions.get(entry.ref);
      if (existing && existing.closedAtMs > session.endedMs) continue;
      resolutions.set(entry.ref, {
        outcome: entry.outcome,
        ...(entry.note !== undefined ? { note: entry.note } : {}),
        closedBy: session.sessionFile,
        closedAt: session.frontmatter.ended,
        closedAtMs: session.endedMs,
      });
    }
  }
  return { resolutions, dangling };
}

export function analyzeLoaded({ sessions, malformed }: LoadedSessions): Analysis {
  const loops = indexLoops(sessions);
  const { resolutions, dangling } = applyResolves(sessions, loops);
  return { loops: [...loops.values()], resolutions, dangling, malformed };
}

async function analyze(initiativeDir: string): Promise<Analysis> {
  return analyzeLoaded(await loadSessionsFromDir(initiativeDir));
}

/** `resolves` entries that did not close a loop, each tagged with why. */
export async function findDanglingResolves(initiativeDir: string): Promise<DanglingResolve[]> {
  const { dangling } = await analyze(initiativeDir);
  return dangling;
}

/**
 * Everything derivation had to work around: rejected `resolves` and session
 * files it could not read. Callers that only render loops can ignore this, but
 * something must report it — a malformed file both drops its own loops and
 * re-opens the ones it closed, and that is invisible in the ledger itself.
 */
export async function findSessionIssues(initiativeDir: string): Promise<SessionIssues> {
  const { dangling, malformed } = await analyze(initiativeDir);
  return { dangling, malformed };
}
