import { isDraft } from '../tasks/draft.js';
import path from 'node:path';
import type { Task } from '../schemas/task.js';
import type { BranchEntry } from '../schemas/artifacts.js';
import { deriveOpenLoopsFrom, deriveResolvedLoopsFrom } from '../sessions/open-loops.js';
import { loadNotesFromDir } from '../notes/note-file.js';
import { indexFreshness, READ_FRESH_BUDGET_MS } from '../session-index/freshness.js';
import { rankNotes, subjectOf, type NoteRelevance } from './rank-notes.js';
import { relatedForLoops, type LoopRetriever } from './loop-context.js';
import { fileHitLog, type HitLogWriter } from '../search/hit-log.js';
import { readLiveLeases, type LiveSibling, type SiblingProbe } from '../sessions/lease.js';
import { today, nowIso } from '../utils/today.js';
import {
  renderFacetSection,
  selectFacetLoops,
  selectFacetTasks,
  type BootstrapFacet,
} from './facet.js';
import {
  loadArtifacts,
  loadBrief,
  loadSessionsNewestFirst,
  loadTasks,
  truncateLines,
} from './load.js';
import {
  compareTasksByPriority,
  formatTimeSince,
  renderRecentlyDone,
  renderTopTasks,
} from './render-tasks.js';
import {
  loopLabel,
  malformedTaskNote,
  renderAbandonedLoops,
  renderClosingInstruction,
  renderDurableNotes,
  renderFacetedLoops,
  renderForeignNotes,
  renderInitClosing,
  renderInitOpening,
  sessionTarget,
} from './render-notes-loops.js';
import { renderArtifactsBody } from './render-artifacts.js';
import { defaultLiveStatusFetcher } from './live-status.js';
import {
  endedDate,
  recoveredMarks,
  renderBriefState,
  renderParallelSessions,
  renderSiblingSessions,
  selectParallelSessions,
} from './render-sessions.js';
import { retrievalDegradations, shownNoteRefs } from './hits.js';

const BRIEF_BODY_MAX_LINES = 40;
const SESSION_BODY_MAX_LINES = 25;
const DEFAULT_TOP_N_TASKS = 5;
const DEFAULT_RECENTLY_DONE_DAYS = 14;

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
interface BootstrapTimings {
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

/**
 * Build the bootstrap prompt for `slug`.
 *
 * The prompt is composed entirely from files under the initiative directory;
 * missing artifacts (no sessions yet, no open tasks, no PRs) degrade
 * gracefully to omitted or "none" sections.
 */
export async function assembleBootstrap(input: BootstrapInput): Promise<BootstrapOutput> {
  const {
    activeRoot,
    slug,
    now = new Date(),
    topNTasks = DEFAULT_TOP_N_TASKS,
    recentlyDoneDays = DEFAULT_RECENTLY_DONE_DAYS,
    includeLiveStatus = true,
    liveStatusFetcher,
    archivedTaskIds,
    loadedTasks: preloadedTasks,
    adhoc = false,
    init = false,
    detectSiblings = true,
    siblingProbe = readLiveLeases,
    ownLeaseId,
    about,
    noteRelevance,
    loopRetriever,
    hitLog = fileHitLog(),
    facet,
    clock = () => performance.now(),
  } = input;

  const loadStart = clock();
  const initiativeDir = path.join(activeRoot, slug);
  const { frontmatter: brief, body: briefBody } = await loadBrief(initiativeDir, slug);

  const [loaded, loadedTasks, loadedArtifacts, notes] = await Promise.all([
    loadSessionsNewestFirst(initiativeDir),
    preloadedTasks ?? loadTasks(initiativeDir),
    loadArtifacts(initiativeDir),
    loadNotesFromDir(initiativeDir),
  ]);
  const { sessions, malformed } = loaded;
  const { tasks, malformed: malformedTasks } = loadedTasks;
  const { artifacts, error: artifactsError } = loadedArtifacts;
  const loadMs = clock() - loadStart;

  // Started now so the gh/git round trips overlap note ranking and loop
  // retrieval; awaited only where artifacts render. Never rejects, so the
  // handler is attached from the start.
  const liveStart = clock();
  let liveStatusMs = 0;
  const artifactsBodyPending = renderArtifactsBody({
    artifacts,
    slug,
    includeLiveStatus,
    fetcher: liveStatusFetcher ?? defaultLiveStatusFetcher,
  }).then((body) => {
    liveStatusMs = clock() - liveStart;
    return body;
  });

  // `mergedPrs` is deliberately unsupplied: derivation must stay offline
  // because bootstrap runs it on every launch.
  const openLoops = deriveOpenLoopsFrom(loaded, { now, tasks });
  const resolvedLoops = deriveResolvedLoopsFrom(loaded, { now, tasks });

  const latestCanonical = sessions.find((s) => s.frontmatter.track === 'canonical');
  // No canonical session recorded for this initiative — fall back to the
  // newest session of any track rather than reporting "no sessions" when
  // sidecar/adhoc sessions exist (AW-42).
  const narrativeSession = latestCanonical ?? sessions[0];
  const usedFallbackTrack = !latestCanonical && narrativeSession !== undefined;
  const parallelBody = renderParallelSessions(selectParallelSessions(sessions, narrativeSession));
  const briefExcerpt =
    truncateLines(briefBody, BRIEF_BODY_MAX_LINES, path.join(initiativeDir, 'brief.md')) ||
    '_(no brief body)_';
  const { body: tasksBody, count: openTaskCount } = renderTopTasks(
    tasks,
    topNTasks,
    slug,
    facet?.tags,
  );
  const { body: recentlyDoneBody, count: recentlyDoneCount } = renderRecentlyDone(
    tasks,
    recentlyDoneDays,
    now,
    slug,
  );
  const timeSinceHuman = narrativeSession
    ? formatTimeSince(new Date(narrativeSession.frontmatter.ended), now)
    : undefined;

  // Fail open, exactly like the live-status fetcher above: a probe that throws
  // (unreadable lease dir, hostile permissions) degrades to "no siblings"
  // rather than costing the caller their whole bootstrap.
  let siblings: SiblingSession[] = [];
  if (detectSiblings) {
    try {
      siblings = await siblingProbe({
        activeRoot,
        slug,
        now,
        ...(ownLeaseId ? { excludeLeaseId: ownLeaseId } : {}),
      });
    } catch {
      siblings = [];
    }
  }
  const openSorted = tasks.filter((t) => t.status === 'open' && !isDraft(t)).sort(compareTasksByPriority);
  const topTask = selectFacetTasks(openSorted, facet?.tags).tasks[0];
  const topTaskTitle = topTask?.title;

  // Ranked against what this session is about, rather than by date (TP-26).
  // `rankNotes` swallows its own failures and hands back date order, so the
  // index staying optional costs nothing here.
  const subject = subjectOf({
    ...(about !== undefined ? { about } : {}),
    briefTitle: brief.title,
    ...(topTask !== undefined ? { topTaskId: topTask.id, topTaskTitle: topTask.title } : {}),
  });
  // Only the live graph needs catching up; a stale one still ranks, just without the newest writes.
  const rankStart = clock();
  if (noteRelevance === undefined) await indexFreshness.ensure(READ_FRESH_BUDGET_MS);
  const noteRanking = rankNotes({
    notes: notes.notes,
    slug,
    subject,
    ...(noteRelevance ? { relevance: noteRelevance } : {}),
  });
  const rankNotesMs = clock() - rankStart;

  const { loops: shownLoops, hidden: hiddenLoops } = selectFacetLoops(
    openLoops,
    tasks,
    facet?.tags,
  );
  // Fails open like the ranking above: no index or no match renders the loops as before.
  const loopLabels = shownLoops.map(loopLabel);
  const loopStart = clock();
  const loopContext = await relatedForLoops({
    loops: shownLoops,
    labels: loopLabels,
    slug,
    shown: shownNoteRefs(noteRanking, slug),
    ...(loopRetriever ? { retriever: loopRetriever } : {}),
  });
  const loopRetrievalMs = clock() - loopStart;
  const retrievalDegraded = await retrievalDegradations(
    { slug, loops: shownLoops, labels: loopLabels, loopContext, noteRanking, subject },
    hitLog,
  );

  const sections: string[] = [];
  sections.push(
    init
      ? renderInitOpening(slug, brief.title)
      : adhoc
        ? `Starting an ad-hoc session on ${sessionTarget(slug, brief.title, facet)}. This session is scoped to ad-hoc work related to this workstream — not necessarily its handoff or current top task. The context below is background so you're oriented; wait for the user to describe the specific ad-hoc task before acting.`
        : `Starting a session on ${sessionTarget(slug, brief.title, facet)}.`,
  );
  const siblingBody = renderSiblingSessions(siblings, brief, topTaskTitle, now);
  if (siblingBody) sections.push(siblingBody);
  const stateBody = renderBriefState(brief, now);
  if (stateBody) sections.push(stateBody);
  sections.push(`# Why we're doing this\n${briefExcerpt}`);
  if (facet) sections.push(renderFacetSection(facet));
  sections.push(
    renderFacetedLoops(shownLoops, hiddenLoops, malformed, sessions[0], {
      slug,
      hits: loopContext.hits,
    }),
  );

  const abandonedBody = renderAbandonedLoops(resolvedLoops, recentlyDoneDays);
  if (abandonedBody) sections.push(abandonedBody);

  if (narrativeSession) {
    const sessionExcerpt =
      truncateLines(
        narrativeSession.body,
        SESSION_BODY_MAX_LINES,
        path.join(initiativeDir, 'sessions', `${narrativeSession.sessionFile}.md`),
      ) || '_(empty session body)_';
    const ended = endedDate(narrativeSession.frontmatter.ended);
    // Label the heading with the track when it's not canonical, so a
    // fallback session (no canonical recorded yet) isn't mistaken for
    // mainline continuity.
    const trackLabel = usedFallbackTrack ? ` (${narrativeSession.frontmatter.track})` : '';
    const recovered = recoveredMarks(narrativeSession.frontmatter);
    sections.push(
      `# Last session${trackLabel}${recovered.label} (${ended}, ${narrativeSession.frontmatter.session_id}) — ${timeSinceHuman}\n${recovered.transcriptLine}${sessionExcerpt}`,
    );
  } else {
    sections.push(`# Last session\nNo previous sessions recorded.`);
  }

  if (parallelBody) sections.push(parallelBody);

  sections.push(
    `# Tasks (top ${topNTasks} open by priority)${malformedTaskNote(malformedTasks)}\n${tasksBody}`,
  );

  if (recentlyDoneBody) {
    sections.push(`# Recently done (last ${recentlyDoneDays} days)\n${recentlyDoneBody}`);
  }

  if (archivedTaskIds && archivedTaskIds.length > 0) {
    sections.push(
      `# Archived (housekeeping)\nMoved ${archivedTaskIds.length} stale done task(s) to tasks/archive/: ${archivedTaskIds.join(', ')}`,
    );
  }

  const notesBody = renderDurableNotes(notes, noteRanking, slug);
  if (notesBody) sections.push(notesBody);
  const foreignBody = renderForeignNotes(noteRanking);
  if (foreignBody) sections.push(foreignBody);

  if (artifactsError) {
    const artifactsPath = path.join(initiativeDir, 'artifacts.yml');
    sections.push(
      `# Open artifacts\n_${artifactsPath} exists but could not be read (${artifactsError}). Branch and stash context is MISSING from this bootstrap — do not treat the working tree as clean. Run \`active-work doctor\`._`,
    );
  } else {
    const artifactsBody = await artifactsBodyPending;
    if (artifactsBody) sections.push(`# Open artifacts\n${artifactsBody}`);
  }

  const bootstrapAt = nowIso();
  const todayStr = today();
  const contextLines = [`- Today: ${todayStr}`, `- Bootstrap: ${bootstrapAt}`];
  if (timeSinceHuman) {
    contextLines.push(`- Time since last session: ${timeSinceHuman}`);
  }
  sections.push(`# Context\n${contextLines.join('\n')}`);

  sections.push(
    init
      ? renderInitClosing(slug, path.join(initiativeDir, 'brief.md'))
      : adhoc
        ? `This is an ad-hoc session: treat the context above as background, not a directive. Do not assume we're continuing the top task or the handoff — the user will describe the specific ad-hoc task. Once they do, work it with the workstream context in mind. If it turns out to be substantive, still capture it via \`active-work task add\` / \`active-work wrap --track adhoc\`. The \`--track adhoc\` flag is required: this session runs alongside the mainline thread, and recording it as canonical would bury the real last session for the next bootstrap.`
        : renderClosingInstruction(shownLoops),
  );

  const prompt = sections.join('\n\n') + '\n';

  const metadata: BootstrapMetadata = {
    slug,
    brief_title: brief.title,
    open_task_count: openTaskCount,
    open_loop_count: openLoops.length,
    recently_done_count: recentlyDoneCount,
    bootstrap_at: bootstrapAt,
  };
  if (narrativeSession) {
    const { generated, transcript } = narrativeSession.frontmatter;
    metadata.last_session = {
      filename: `${narrativeSession.sessionFile}.md`,
      ended: narrativeSession.frontmatter.ended,
      ...(generated === true ? { recovered: true as const } : {}),
      ...(generated === true && transcript !== undefined ? { transcript } : {}),
    };
  }
  if (timeSinceHuman) {
    metadata.time_since_last_session_human = timeSinceHuman;
  }
  if (siblings.length > 0) {
    metadata.sibling_sessions = siblings.length;
  }
  if (retrievalDegraded.length > 0) {
    metadata.retrieval_degraded = retrievalDegraded;
  }
  if (facet) metadata.facet = facet.name;
  metadata.timings_ms = {
    load: loadMs,
    live_status: liveStatusMs,
    rank_notes: rankNotesMs,
    loop_retrieval: loopRetrievalMs,
    loop_queries: shownLoops.length,
  };

  return { prompt, metadata };
}
