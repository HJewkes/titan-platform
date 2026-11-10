import path from 'node:path';
import { isDraft } from '../tasks/draft.js';
import type { Task } from '../schemas/task.js';
import { deriveOpenLoopsFrom, deriveResolvedLoopsFrom } from '../sessions/open-loops.js';
import { loadNotesFromDir } from '../notes/note-file.js';
import { indexFreshness, READ_FRESH_BUDGET_MS } from '../session-index/freshness.js';
import { fileHitLog } from '../search/hit-log.js';
import { readLiveLeases } from '../sessions/lease.js';
import { today, nowIso } from '../utils/today.js';
import { rankNotes, subjectOf, type NoteRanking } from './rank-notes.js';
import { relatedForLoops } from './loop-context.js';
import { selectFacetLoops, selectFacetTasks } from './facet.js';
import { loadArtifacts, loadBrief, loadSessionsNewestFirst, loadTasks } from './load.js';
import {
  compareTasksByPriority,
  formatTimeSince,
  renderRecentlyDone,
  renderTopTasks,
} from './render-tasks.js';
import { loopLabel } from './render-notes-loops.js';
import { renderArtifactsBody } from './render-artifacts.js';
import { defaultLiveStatusFetcher } from './live-status.js';
import { retrievalDegradations, shownNoteRefs } from './hits.js';
import type { BootstrapView, ResolvedBootstrapInput } from './sections.js';
import type { BootstrapInput, BootstrapTimings, SiblingSession } from './prompt.js';

const DEFAULT_TOP_N_TASKS = 5;
const DEFAULT_RECENTLY_DONE_DAYS = 14;

export type GatheredView = BootstrapView & { timings: BootstrapTimings };

export function withDefaults(input: BootstrapInput): ResolvedBootstrapInput {
  return {
    ...input,
    now: input.now ?? new Date(),
    topNTasks: input.topNTasks ?? DEFAULT_TOP_N_TASKS,
    recentlyDoneDays: input.recentlyDoneDays ?? DEFAULT_RECENTLY_DONE_DAYS,
    includeLiveStatus: input.includeLiveStatus ?? true,
    adhoc: input.adhoc ?? false,
    init: input.init ?? false,
    detectSiblings: input.detectSiblings ?? true,
    siblingProbe: input.siblingProbe ?? readLiveLeases,
    hitLog: input.hitLog ?? fileHitLog(),
    clock: input.clock ?? (() => performance.now()),
  };
}

async function loadInitiative(input: ResolvedBootstrapInput, initiativeDir: string) {
  const { frontmatter: brief, body: briefBody } = await loadBrief(initiativeDir, input.slug);
  const [sessions, tasks, artifacts, notes] = await Promise.all([
    loadSessionsNewestFirst(initiativeDir),
    input.loadedTasks ?? loadTasks(initiativeDir),
    loadArtifacts(initiativeDir),
    loadNotesFromDir(initiativeDir),
  ]);
  return { brief, briefBody, sessions, tasks, artifacts, notes };
}

type LoadedInitiative = Awaited<ReturnType<typeof loadInitiative>>;

const ZERO_TIMINGS: BootstrapTimings = {
  load: 0,
  live_status: 0,
  rank_notes: 0,
  loop_retrieval: 0,
  loop_queries: 0,
};

async function timedLoad(input: ResolvedBootstrapInput, timings: BootstrapTimings) {
  const loadStart = input.clock();
  const initiativeDir = path.join(input.activeRoot, input.slug);
  const loaded = await loadInitiative(input, initiativeDir);
  timings.load = input.clock() - loadStart;
  return { initiativeDir, loaded };
}

/**
 * Started before ranking so the gh/git round trips overlap note ranking and
 * loop retrieval. Never rejects, so nothing is left unhandled while it runs.
 */
function startArtifactsBody(
  input: ResolvedBootstrapInput,
  loaded: LoadedInitiative,
  timings: BootstrapTimings,
): Promise<string | null> {
  const liveStart = input.clock();
  return renderArtifactsBody({
    artifacts: loaded.artifacts.artifacts,
    slug: input.slug,
    includeLiveStatus: input.includeLiveStatus,
    fetcher: input.liveStatusFetcher ?? defaultLiveStatusFetcher,
  }).then((body) => {
    timings.live_status = input.clock() - liveStart;
    return body;
  });
}

/**
 * Fails open like the live-status fetcher: a probe that throws (unreadable
 * lease dir, hostile permissions) degrades to "no siblings" rather than
 * costing the caller their whole bootstrap.
 */
async function probeSiblings(input: ResolvedBootstrapInput): Promise<SiblingSession[]> {
  if (!input.detectSiblings) return [];
  const { activeRoot, slug, now, ownLeaseId } = input;
  try {
    return await input.siblingProbe({
      activeRoot,
      slug,
      now,
      ...(ownLeaseId ? { excludeLeaseId: ownLeaseId } : {}),
    });
  } catch {
    return [];
  }
}

/**
 * Ranked against what this session is about rather than by date (TP-26).
 * `rankNotes` swallows its own failures and hands back date order, so the
 * index staying optional costs nothing here.
 */
async function rankForSession(
  input: ResolvedBootstrapInput,
  loaded: LoadedInitiative,
  topTask: Task | undefined,
  timings: BootstrapTimings,
) {
  const { about, noteRelevance, slug } = input;
  const subject = subjectOf({
    ...(about !== undefined ? { about } : {}),
    briefTitle: loaded.brief.title,
    ...(topTask !== undefined ? { topTaskId: topTask.id, topTaskTitle: topTask.title } : {}),
  });
  const rankStart = input.clock();
  // Only the live graph needs catching up; a stale one still ranks, just without the newest writes.
  if (noteRelevance === undefined) await indexFreshness.ensure(READ_FRESH_BUDGET_MS);
  const noteRanking = rankNotes({
    notes: loaded.notes.notes,
    slug,
    subject,
    ...(noteRelevance ? { relevance: noteRelevance } : {}),
  });
  timings.rank_notes = input.clock() - rankStart;
  return { subject, noteRanking };
}

/** Fails open like the ranking: no index or no match renders the loops as before. */
async function loopsForSession(
  input: ResolvedBootstrapInput,
  loaded: LoadedInitiative,
  ranked: { subject: string; noteRanking: NoteRanking },
  timings: BootstrapTimings,
) {
  const { slug, facet, now, loopRetriever } = input;
  const tasks = loaded.tasks.tasks;
  // `mergedPrs` is deliberately unsupplied: derivation must stay offline
  // because bootstrap runs it on every launch.
  const openLoops = deriveOpenLoopsFrom(loaded.sessions, { now, tasks });
  const selection = selectFacetLoops(openLoops, tasks, facet?.tags);
  const labels = selection.loops.map(loopLabel);
  const loopStart = input.clock();
  const loopContext = await relatedForLoops({
    loops: selection.loops,
    labels,
    slug,
    shown: shownNoteRefs(ranked.noteRanking, slug),
    ...(loopRetriever ? { retriever: loopRetriever } : {}),
  });
  timings.loop_retrieval = input.clock() - loopStart;
  timings.loop_queries = selection.loops.length;
  const retrievalDegraded = await retrievalDegradations(
    { slug, loops: selection.loops, labels, loopContext, ...ranked },
    input.hitLog,
  );
  return { openLoops, selection, loopContext, retrievalDegraded };
}

/** With no canonical session recorded, fall back to the newest of any track (AW-42). */
function narrativeOf(sessions: LoadedInitiative['sessions']['sessions'], now: Date) {
  const latestCanonical = sessions.find((s) => s.frontmatter.track === 'canonical');
  const narrativeSession = latestCanonical ?? sessions.at(0);
  return {
    narrativeSession,
    usedFallbackTrack: !latestCanonical && narrativeSession !== undefined,
    timeSinceHuman: narrativeSession
      ? formatTimeSince(new Date(narrativeSession.frontmatter.ended), now)
      : undefined,
  };
}

function topTaskOf(tasks: Task[], tags: string[] | undefined): Task | undefined {
  const openSorted = tasks
    .filter((t) => t.status === 'open' && !isDraft(t))
    .sort(compareTasksByPriority);
  return selectFacetTasks(openSorted, tags).tasks[0];
}

/** The view fields that are pure functions of what was loaded from disk. */
function loadedFields(input: ResolvedBootstrapInput, loaded: LoadedInitiative) {
  const { slug, now, facet } = input;
  const { sessions, malformed: malformedSessions } = loaded.sessions;
  const { tasks, malformed: malformedTasks } = loaded.tasks;
  return {
    brief: loaded.brief,
    briefBody: loaded.briefBody,
    sessions,
    malformedSessions,
    malformedTasks,
    resolvedLoops: deriveResolvedLoopsFrom(loaded.sessions, { now, tasks }),
    ...narrativeOf(sessions, now),
    topTasks: renderTopTasks(tasks, input.topNTasks, slug, facet?.tags),
    recentlyDone: renderRecentlyDone(tasks, input.recentlyDoneDays, now, slug),
    notes: loaded.notes,
  };
}

/** The I/O phase, in the order the prompt has always been assembled in. */
export async function gatherBootstrap(input: ResolvedBootstrapInput): Promise<GatheredView> {
  const timings: BootstrapTimings = { ...ZERO_TIMINGS };
  const { initiativeDir, loaded } = await timedLoad(input, timings);
  const artifactsBodyPending = startArtifactsBody(input, loaded, timings);
  const siblings = await probeSiblings(input);
  const topTask = topTaskOf(loaded.tasks.tasks, input.facet?.tags);
  const ranked = await rankForSession(input, loaded, topTask, timings);
  const loops = await loopsForSession(input, loaded, ranked, timings);
  const artifactsError = loaded.artifacts.error;
  return {
    ...loadedFields(input, loaded),
    input,
    initiativeDir,
    openLoopCount: loops.openLoops.length,
    shownLoops: loops.selection.loops,
    hiddenLoops: loops.selection.hidden,
    loopContext: loops.loopContext,
    retrievalDegraded: loops.retrievalDegraded,
    siblings,
    topTaskTitle: topTask?.title,
    noteRanking: ranked.noteRanking,
    artifactsError,
    artifactsBody: artifactsError ? null : await artifactsBodyPending,
    bootstrapAt: nowIso(),
    today: today(),
    timings,
  };
}
