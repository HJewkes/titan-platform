/**
 * Open loops are *derived*, never stored: each session records the loops it
 * opens (`next_steps`) and the loops it closes (`resolves`), and live state is
 * whatever is left unresolved. There is no denormalized copy, so there is
 * nothing that can go stale.
 *
 * Derivation deliberately ignores `track` — ad-hoc and sidecar sessions open
 * real loops. `track` only selects which session is the narrative "last
 * mainline session"; it must not gate the ledger.
 */

import type { NextStep } from '../schemas/session.js';
import type { Task } from '../schemas/task.js';
import { loadSessionsFromDir, type LoadedSessions } from './load-sessions.js';
import { analyzeLoaded, type LoopEntry, type Resolution } from './loop-resolution.js';

export { loadSessionsFromDir } from './load-sessions.js';
export type { LoadedSession, LoadedSessions, MalformedSession } from './load-sessions.js';
export { findDanglingResolves, findSessionIssues } from './loop-resolution.js';
export type { DanglingKind, DanglingResolve } from './loop-resolution.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface OpenLoop {
  /**
   * Global reference: `<session file stem>#<next_step id>`. The stem, not
   * `session_id`: a session that records more than once produces several files
   * sharing one `session_id` (`pickAvailableFilename` appends `-1`, `-2`), so
   * only the filename is unique within an initiative.
   */
  ref: string;
  text: string;
  kind: 'task' | 'pr' | 'prose';
  /** The yaml `ref` field of the next_step (task id or PR number), when present. */
  targetRef?: string;
  /** ISO timestamp after which the loop's trigger is met, when the opener set one. */
  due?: string;
  /** Set when `loop open --origin` filed the loop at a handoff, teleport or wrap. */
  origin?: 'handoff' | 'teleport' | 'wrap';
  /** The owning seat, from `loop open --seat`. */
  seat?: string;
  /** Session filename without `.md` — the identity half of `ref`. */
  sessionFile: string;
  /** Frontmatter `session_id`, kept for display; not unique. */
  sessionId: string;
  /** ISO timestamp — the originating session's `ended`. */
  openedAt: string;
  /** Whole days between `openedAt` and the injected `now`. */
  ageDays: number;
}

interface DeriveOptions {
  /** Injected for determinism; this module never calls `new Date()`. */
  now: Date;
  /** Auto-closes `kind: 'task'` loops whose `ref` names a done task. */
  tasks?: Task[];
  /**
   * PR refs known merged, supplied by the caller. Derivation stays pure and
   * offline (bootstrap runs it on every launch) and `artifacts.yml` persists no
   * PR state, so without this list PR loops stay open until resolved manually.
   */
  mergedPrs?: string[];
}

/**
 * A loop that was closed, and how.
 *
 * `outcome` and `note` were write-only until AW-59: derivation reduced every
 * resolve to the bare fact that a ref had closed, so a loop deliberately
 * abandoned — with the reason the schema *requires* for exactly that case —
 * explained itself to nobody. An abandonment is a decision, and decisions are
 * the part of a ledger worth keeping.
 */
export interface ResolvedLoop {
  ref: string;
  text: string;
  kind: 'task' | 'pr' | 'prose';
  outcome: 'done' | 'abandoned';
  note?: string;
  /** Stem of the session that opened the loop. */
  sessionFile: string;
  /** Stem of the session that closed it. */
  closedBy: string;
  openedAt: string;
  /** ISO timestamp — the closing session's `ended`. */
  closedAt: string;
  /** Whole days between `closedAt` and the injected `now`. */
  ageDays: number;
}

/**
 * `#57`, `57`, and a full `https://github.com/o/r/pull/57` URL are all the same
 * PR. Whoever files a loop pastes whichever form is to hand, so both the
 * merged-PR matching below and the bootstrap's label depend on collapsing them
 * — an un-collapsed URL rendered as `PR #https://github.com/...` (AW-71).
 */
export function normalizePrRef(ref: string): string {
  const trimmed = ref.trim();
  const fromUrl = /\/pull\/(\d+)/.exec(trimmed);
  return fromUrl?.[1] ?? trimmed.replace(/^#/, '');
}

function isTargetClosed(
  kind: NextStep['kind'],
  target: string | undefined,
  opts: DeriveOptions,
): boolean {
  if (target === undefined) return false;
  if (kind === 'task' && opts.tasks) {
    return opts.tasks.some((t) => t.id === target && t.status === 'done');
  }
  if (kind === 'pr' && opts.mergedPrs) {
    const wanted = normalizePrRef(target);
    return opts.mergedPrs.some((ref) => normalizePrRef(ref) === wanted);
  }
  return false;
}

function isAutoResolved(entry: LoopEntry, opts: DeriveOptions): boolean {
  return isTargetClosed(entry.step.kind, entry.step.ref, opts);
}

/** Why a loop needs attention now: its task closed, its PR merged, or its due time passed. */
export type LoopTrigger = 'task-done' | 'pr-merged' | 'due';

/**
 * The triggers of an open loop that have fired (TP-913).
 *
 * A promise is filed as a loop with a condition; when the condition holds, the
 * promised action is owed. Derive `loop` without `tasks` or `mergedPrs`, or the
 * loops whose target closed are auto-resolved away before they can be marked.
 */
export function triggersMet(loop: OpenLoop, opts: DeriveOptions): LoopTrigger[] {
  const met: LoopTrigger[] = [];
  if (isTargetClosed(loop.kind, loop.targetRef, opts)) {
    met.push(loop.kind === 'task' ? 'task-done' : 'pr-merged');
  }
  if (loop.due !== undefined && new Date(loop.due).getTime() <= opts.now.getTime()) {
    met.push('due');
  }
  return met;
}

function toOpenLoop(entry: LoopEntry, now: Date): OpenLoop {
  const ageMs = now.getTime() - entry.session.endedMs;
  return {
    ref: entry.ref,
    text: entry.step.text,
    ...(entry.step.ref !== undefined ? { targetRef: entry.step.ref } : {}),
    ...(entry.step.due !== undefined ? { due: entry.step.due } : {}),
    ...(entry.step.origin !== undefined ? { origin: entry.step.origin } : {}),
    ...(entry.step.seat !== undefined ? { seat: entry.step.seat } : {}),
    kind: entry.step.kind,
    sessionFile: entry.session.sessionFile,
    sessionId: entry.session.sessionId,
    openedAt: entry.session.ended,
    ageDays: Math.max(0, Math.floor(ageMs / MS_PER_DAY)),
  };
}

/**
 * Unresolved loops from already-parsed sessions, oldest first.
 *
 * Callers holding a `loadSessionsFromDir` result (bootstrap does — it renders
 * the same sessions) use this so the files are read and parsed exactly once.
 */
export function deriveOpenLoopsFrom(loaded: LoadedSessions, opts: DeriveOptions): OpenLoop[] {
  const { loops, resolutions } = analyzeLoaded(loaded);
  return loops
    .filter((entry) => !resolutions.has(entry.ref) && !isAutoResolved(entry, opts))
    .map((entry) => toOpenLoop(entry, opts.now))
    .sort(
      (a, b) =>
        new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime() ||
        a.ref.localeCompare(b.ref),
    );
}

/** Unresolved loops for an initiative, oldest first. */
export async function deriveOpenLoops(
  initiativeDir: string,
  opts: DeriveOptions,
): Promise<OpenLoop[]> {
  return deriveOpenLoopsFrom(await loadSessionsFromDir(initiativeDir), opts);
}

function toResolvedLoop(entry: LoopEntry, resolution: Resolution, now: Date): ResolvedLoop {
  const ageMs = now.getTime() - new Date(resolution.closedAt).getTime();
  return {
    ref: entry.ref,
    text: entry.step.text,
    kind: entry.step.kind,
    outcome: resolution.outcome,
    ...(resolution.note !== undefined ? { note: resolution.note } : {}),
    sessionFile: entry.session.sessionFile,
    closedBy: resolution.closedBy,
    openedAt: entry.session.ended,
    closedAt: resolution.closedAt,
    ageDays: Math.max(0, Math.floor(ageMs / MS_PER_DAY)),
  };
}

/**
 * Loops that were explicitly closed, newest first.
 *
 * Excludes auto-resolution (a done task, a merged PR): those carry no stated
 * outcome or reason, and inferring "done" for them would put words in the
 * operator's mouth.
 */
export function deriveResolvedLoopsFrom(
  loaded: LoadedSessions,
  opts: DeriveOptions,
): ResolvedLoop[] {
  const { loops, resolutions } = analyzeLoaded(loaded);
  return loops
    .flatMap((entry) => {
      const resolution = resolutions.get(entry.ref);
      return resolution ? [toResolvedLoop(entry, resolution, opts.now)] : [];
    })
    .sort(
      (a, b) =>
        new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime() ||
        a.ref.localeCompare(b.ref),
    );
}

/** Explicitly closed loops for an initiative, newest first. */
export async function deriveResolvedLoops(
  initiativeDir: string,
  opts: DeriveOptions,
): Promise<ResolvedLoop[]> {
  return deriveResolvedLoopsFrom(await loadSessionsFromDir(initiativeDir), opts);
}
