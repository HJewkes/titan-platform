import type { Task } from '../schemas/task.js';
import type { BranchEntry } from '../schemas/artifacts.js';
import type { LoadedSession } from '../sessions/open-loops.js';
import type { NoteRelevance } from './rank-notes.js';
import type { LoopRetriever } from './loop-context.js';
import type { HitLogWriter } from '../search/hit-log.js';
import type { LiveSibling, SiblingProbe } from '../sessions/lease.js';
import type { BootstrapFacet } from './facet.js';
import { bootstrapSections } from './sections.js';
import { gatherBootstrap, withDefaults, type GatheredView } from './gather.js';

export interface LiveBranchStatus {
  repo: string;
  name: string;
  note?: string;
  present: boolean;
  last_commit_iso: string | null;
  ahead: number | null;
  behind: number | null;
  pr: {
    number: number;
    state: string;
    title: string;
    url: string;
    checks?: string;
  } | null;
}

export type LiveStatusFetcher = (branches: BranchEntry[]) => Promise<LiveBranchStatus[]>;

/** Re-exported so callers can type a sibling list without reaching into `sessions/`. */
export type SiblingSession = LiveSibling;
export type { SiblingProbe };

export interface BootstrapInput {
  /** Active root directory. Used to resolve the initiative dir. */
  activeRoot: string;
  slug: string;
  /** Injectable "now" for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
  /** Cap for top open tasks shown. Defaults to 5. */
  topNTasks?: number;
  /** Window for the "recently done" section. Defaults to 14 days. */
  recentlyDoneDays?: number;
  /**
   * When `true` (default), the bootstrap pulls live branch/PR state via
   * `git` + `gh`. When `false`, only the static `artifacts.yml` data is
   * rendered — useful for offline contexts and fast-path test runs.
   */
  includeLiveStatus?: boolean;
  /**
   * Optional fetcher override (DI). Defaults to a built-in walker that
   * shells out via the shared `git`/`gh` runners. The walker is bounded
   * (~10 branches) and swallows per-branch errors; render falls back to
   * static when the whole fetch throws.
   */
  liveStatusFetcher?: LiveStatusFetcher;
  /**
   * Task ids the caller archived just before this bootstrap (AW-8). Rendered as
   * a short housekeeping note so the session knows they left the active list;
   * the actual file moves happen in the `open` command, not here.
   */
  archivedTaskIds?: string[];
  /**
   * Tasks the caller already parsed (minus any it archived). When supplied the
   * task directory is not read again.
   */
  loadedTasks?: LoadedTasks;
  /**
   * When `true`, frame the session as ad-hoc work related to the workstream
   * rather than a continuation of its handoff / top task. The same context is
   * rendered, but the opening and closing directives tell the session to treat
   * it as background and await the user's specific ad-hoc task (AW-20).
   */
  adhoc?: boolean;
  /**
   * When `true`, frame the session as the first one on a just-scaffolded
   * initiative: set it up with the user (brief, worktree, sources, tasks)
   * before any other work (TP-356). Takes precedence over `adhoc`.
   */
  init?: boolean;
  /**
   * When `true` (default), probe for other sessions holding a lease on this
   * initiative and warn about them at the top of the prompt (CC-9).
   */
  detectSiblings?: boolean;
  /**
   * Optional probe override (DI). Defaults to reading the lease directory under
   * the active root. A probe that throws is treated as "no siblings" — this
   * section is advisory and must never be able to fail a bootstrap.
   */
  siblingProbe?: SiblingProbe;
  /** This session's own lease, excluded from the sibling list. */
  ownLeaseId?: string;
  /**
   * What this session is about, overriding the top task and brief titles that
   * otherwise supply the subject the notes are ranked against (TP-26).
   */
  about?: string;
  /**
   * Optional relevance source (DI). Defaults to a query against the live graph.
   * One that throws yields date-ordered notes, never a failed bootstrap.
   */
  noteRelevance?: NoteRelevance;
  /**
   * Optional per-loop retriever (DI). Defaults to `context related` against the
   * live graph. One that throws or finds nothing renders the loops as before.
   */
  loopRetriever?: LoopRetriever;
  /** Optional hit log (DI). Defaults to `retrieval-hits.jsonl` in the state dir. */
  hitLog?: HitLogWriter;
  /** Facet alias the session opened through; scopes tasks and loops to its tags (TP-326). */
  facet?: BootstrapFacet;
  /** Millisecond clock (DI) for `timings_ms`. Defaults to `performance.now`. */
  clock?: () => number;
}

export interface BootstrapMetadata {
  slug: string;
  brief_title: string;
  /** `recovered` and `transcript` are set for a record `session recover` rebuilt (TP-1711). */
  last_session?: { filename: string; ended: string; recovered?: true; transcript?: string };
  time_since_last_session_human?: string;
  open_task_count: number;
  open_loop_count: number;
  recently_done_count: number;
  bootstrap_at: string;
  /** Number of sibling sessions rendered; absent when none were found. */
  sibling_sessions?: number;
  /** Why retrieval showed less than it might have; absent when nothing degraded. */
  retrieval_degraded?: string[];
  /** Facet alias the session opened through; absent for a plain slug. */
  facet?: string;
  /** Per-phase wall time; metadata only, never rendered into the prompt. */
  timings_ms?: BootstrapTimings & { archive?: number; total?: number };
}

/** Milliseconds each assembly phase took; `loop_queries` counts the loop retrievals run. */
export interface BootstrapTimings {
  load: number;
  live_status: number;
  rank_notes: number;
  loop_retrieval: number;
  loop_queries: number;
}

interface BootstrapOutput {
  prompt: string;
  metadata: BootstrapMetadata;
}

/** A task file that would not parse. Mirrors `MalformedSession`. */
export interface MalformedTask {
  /** Filename including extension; a malformed file may have no usable id. */
  file: string;
  reason: string;
}

export interface LoadedTasks {
  tasks: Task[];
  malformed: MalformedTask[];
}


function lastSessionMetadata(session: LoadedSession): BootstrapMetadata['last_session'] {
  const { generated, transcript } = session.frontmatter;
  return {
    filename: `${session.sessionFile}.md`,
    ended: session.frontmatter.ended,
    ...(generated === true ? { recovered: true as const } : {}),
    ...(generated === true && transcript !== undefined ? { transcript } : {}),
  };
}

function bootstrapMetadata(view: GatheredView): BootstrapMetadata {
  const { input, narrativeSession, timeSinceHuman, siblings, retrievalDegraded } = view;
  return {
    slug: input.slug,
    brief_title: view.brief.title,
    open_task_count: view.topTasks.count,
    open_loop_count: view.openLoopCount,
    recently_done_count: view.recentlyDone.count,
    bootstrap_at: view.bootstrapAt,
    ...(narrativeSession ? { last_session: lastSessionMetadata(narrativeSession) } : {}),
    ...(timeSinceHuman ? { time_since_last_session_human: timeSinceHuman } : {}),
    ...(siblings.length > 0 ? { sibling_sessions: siblings.length } : {}),
    ...(retrievalDegraded.length > 0 ? { retrieval_degraded: retrievalDegraded } : {}),
    ...(input.facet ? { facet: input.facet.name } : {}),
    timings_ms: { ...view.timings },
  };
}

/**
 * Build the bootstrap prompt for `slug`.
 *
 * The prompt is composed entirely from files under the initiative directory;
 * missing artifacts (no sessions yet, no open tasks, no PRs) degrade
 * gracefully to omitted or "none" sections.
 */
export async function assembleBootstrap(input: BootstrapInput): Promise<BootstrapOutput> {
  const view = await gatherBootstrap(withDefaults(input));
  const prompt = bootstrapSections(view).join('\n\n') + '\n';
  return { prompt, metadata: bootstrapMetadata(view) };
}
