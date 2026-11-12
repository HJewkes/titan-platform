import path from 'node:path';
import type { BriefFrontmatter } from '../schemas/brief.js';
import type { LoadedNotes } from '../notes/note-file.js';
import type {
  LoadedSession,
  MalformedSession,
  OpenLoop,
  ResolvedLoop,
} from '../sessions/open-loops.js';
import type { NoteRanking } from './rank-notes.js';
import type { LoopContext } from './loop-context.js';
import { renderFacetSection } from './facet.js';
import { truncateLines } from './load.js';
import {
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
import {
  endedDate,
  recoveredMarks,
  renderBriefState,
  renderParallelSessions,
  renderSiblingSessions,
  selectParallelSessions,
} from './render-sessions.js';
import type { BootstrapInput, MalformedTask, SiblingSession } from './prompt.js';

const BRIEF_BODY_MAX_LINES = 40;
const SESSION_BODY_MAX_LINES = 25;

type Defaulted =
  | 'now'
  | 'topNTasks'
  | 'recentlyDoneDays'
  | 'includeLiveStatus'
  | 'adhoc'
  | 'init'
  | 'detectSiblings'
  | 'siblingProbe'
  | 'hitLog'
  | 'clock';

/** `BootstrapInput` with every documented default filled in. */
export type ResolvedBootstrapInput = BootstrapInput & Required<Pick<BootstrapInput, Defaulted>>;

interface RenderedCount<Body = string> {
  body: Body;
  count: number;
}

/** Everything the I/O phase gathered; the sections and metadata are pure functions of it. */
export interface BootstrapView {
  input: ResolvedBootstrapInput;
  initiativeDir: string;
  brief: BriefFrontmatter;
  briefBody: string;
  sessions: LoadedSession[];
  malformedSessions: MalformedSession[];
  malformedTasks: MalformedTask[];
  openLoopCount: number;
  resolvedLoops: ResolvedLoop[];
  shownLoops: OpenLoop[];
  hiddenLoops: number;
  loopContext: LoopContext;
  narrativeSession: LoadedSession | undefined;
  usedFallbackTrack: boolean;
  timeSinceHuman: string | undefined;
  siblings: SiblingSession[];
  topTaskTitle: string | undefined;
  topTasks: RenderedCount;
  recentlyDone: RenderedCount<string | null>;
  notes: LoadedNotes;
  noteRanking: NoteRanking;
  artifactsError: string | undefined;
  artifactsBody: string | null;
  retrievalDegraded: string[];
  bootstrapAt: string;
  today: string;
}

type SectionBuilder = (view: BootstrapView) => string | null;

const ADHOC_OPENING =
  "This session is scoped to ad-hoc work related to this workstream — not necessarily its handoff or current top task. The context below is background so you're oriented; wait for the user to describe the specific ad-hoc task before acting.";

const ADHOC_CLOSING =
  "This is an ad-hoc session: treat the context above as background, not a directive. Do not assume we're continuing the top task or the handoff — the user will describe the specific ad-hoc task. Once they do, work it with the workstream context in mind. If it turns out to be substantive, still capture it via `active-work task add` / `active-work wrap --track adhoc`. The `--track adhoc` flag is required: this session runs alongside the mainline thread, and recording it as canonical would bury the real last session for the next bootstrap.";

function opening({ input, brief }: BootstrapView): string {
  const { init, adhoc, slug, facet } = input;
  if (init) return renderInitOpening(slug, brief.title);
  const target = sessionTarget(slug, brief.title, facet);
  return adhoc
    ? `Starting an ad-hoc session on ${target}. ${ADHOC_OPENING}`
    : `Starting a session on ${target}.`;
}

function briefExcerpt({ briefBody, initiativeDir }: BootstrapView): string {
  const excerpt =
    truncateLines(briefBody, BRIEF_BODY_MAX_LINES, path.join(initiativeDir, 'brief.md')) ||
    '_(no brief body)_';
  return `# Why we're doing this\n${excerpt}`;
}

function openLoops(view: BootstrapView): string {
  const { shownLoops, hiddenLoops, malformedSessions, sessions, input, loopContext } = view;
  return renderFacetedLoops(shownLoops, hiddenLoops, malformedSessions, sessions[0], {
    slug: input.slug,
    hits: loopContext.hits,
  });
}

function lastSession(view: BootstrapView): string {
  const session = view.narrativeSession;
  if (!session) return `# Last session\nNo previous sessions recorded.`;
  const sessionPath = path.join(view.initiativeDir, 'sessions', `${session.sessionFile}.md`);
  const excerpt =
    truncateLines(session.body, SESSION_BODY_MAX_LINES, sessionPath) || '_(empty session body)_';
  const ended = endedDate(session.frontmatter.ended);
  // A fallback session (no canonical recorded yet) is labelled with its track
  // so it is not mistaken for mainline continuity.
  const trackLabel = view.usedFallbackTrack ? ` (${session.frontmatter.track})` : '';
  const recovered = recoveredMarks(session.frontmatter);
  return `# Last session${trackLabel}${recovered.label} (${ended}, ${session.frontmatter.session_id}) — ${view.timeSinceHuman}\n${recovered.transcriptLine}${excerpt}`;
}

function topTasks({ input, malformedTasks, topTasks: rendered }: BootstrapView): string {
  return `# Tasks (top ${input.topNTasks} open by priority)${malformedTaskNote(malformedTasks)}\n${
    rendered.body
  }`;
}

function recentlyDone({ input, recentlyDone: rendered }: BootstrapView): string | null {
  if (!rendered.body) return null;
  return `# Recently done (last ${input.recentlyDoneDays} days)\n${rendered.body}`;
}

function archived({ input }: BootstrapView): string | null {
  const ids = input.archivedTaskIds;
  if (!ids || ids.length === 0) return null;
  return `# Archived (housekeeping)\nMoved ${
    ids.length
  } stale done task(s) to tasks/archive/: ${ids.join(', ')}`;
}

function openArtifacts(view: BootstrapView): string | null {
  if (view.artifactsError) {
    const artifactsPath = path.join(view.initiativeDir, 'artifacts.yml');
    return `# Open artifacts\n_${artifactsPath} exists but could not be read (${view.artifactsError}). Branch and stash context is MISSING from this bootstrap — do not treat the working tree as clean. Run \`active-work doctor\`._`;
  }
  return view.artifactsBody ? `# Open artifacts\n${view.artifactsBody}` : null;
}

function context({ today, bootstrapAt, timeSinceHuman }: BootstrapView): string {
  const lines = [`- Today: ${today}`, `- Bootstrap: ${bootstrapAt}`];
  if (timeSinceHuman) lines.push(`- Time since last session: ${timeSinceHuman}`);
  return `# Context\n${lines.join('\n')}`;
}

function closing({ input, initiativeDir, shownLoops }: BootstrapView): string {
  if (input.init) return renderInitClosing(input.slug, path.join(initiativeDir, 'brief.md'));
  return input.adhoc ? ADHOC_CLOSING : renderClosingInstruction(shownLoops);
}

/** One builder per prompt section, in prompt order; `null` omits the section. */
const SECTION_BUILDERS: readonly SectionBuilder[] = [
  opening,
  (v) => renderSiblingSessions(v.siblings, v.brief, v.topTaskTitle, v.input.now),
  (v) => renderBriefState(v.brief, v.input.now),
  briefExcerpt,
  (v) => (v.input.facet ? renderFacetSection(v.input.facet) : null),
  openLoops,
  (v) => renderAbandonedLoops(v.resolvedLoops, v.input.recentlyDoneDays),
  lastSession,
  (v) => renderParallelSessions(selectParallelSessions(v.sessions, v.narrativeSession)),
  topTasks,
  recentlyDone,
  archived,
  (v) => renderDurableNotes(v.notes, v.noteRanking, v.input.slug),
  (v) => renderForeignNotes(v.noteRanking),
  openArtifacts,
  context,
  closing,
];

export function bootstrapSections(view: BootstrapView): string[] {
  return SECTION_BUILDERS.map((build) => build(view)).filter(
    (section): section is string => section !== null && section !== '',
  );
}
