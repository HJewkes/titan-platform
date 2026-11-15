import type { BriefFrontmatter } from '../schemas/brief.js';
import type { LoadedSession } from '../sessions/open-loops.js';
import {
  buildWorkerRollup,
  isWorkerRecord,
  renderWorkerRollup,
  type RollupInput,
} from '../sessions/worker-rollup.js';
import { firstLine } from './render-tasks.js';
import type { SiblingSession } from './prompt.js';

export function endedDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Marks for a record `session recover` rebuilt from a transcript (TP-1711),
 * so the next session does not read facts scraped after a crash as a wrap.
 */
export function recoveredMarks(fm: LoadedSession['frontmatter']): {
  label: string;
  transcriptLine: string;
} {
  if (fm.generated !== true) return { label: '', transcriptLine: '' };
  const transcriptLine = fm.transcript ? `Transcript: \`${fm.transcript}\`\n` : '';
  return { label: ' (recovered)', transcriptLine };
}

/**
 * Sessions on a non-canonical track that ended after the narrative session
 * (the one rendered in `# Last session`).
 *
 * These ran alongside the mainline thread, so they're worth surfacing — but
 * only as pointers: full bodies would crowd out the mainline context. The
 * narrative session itself is excluded so it isn't both the mainline block
 * and a parallel pointer (matters when it was chosen via the no-canonical
 * fallback, since it's then a non-canonical session too).
 */
export function selectParallelSessions(
  sessions: LoadedSession[],
  narrativeSession: LoadedSession | undefined,
): LoadedSession[] {
  if (!narrativeSession) return [];
  const cutoff = new Date(narrativeSession.frontmatter.ended).getTime();
  return sessions.filter(
    (s) =>
      s !== narrativeSession &&
      s.frontmatter.ledger !== true &&
      s.frontmatter.track !== 'canonical' &&
      new Date(s.frontmatter.ended).getTime() > cutoff,
  );
}

const WORKER_ROLLUP_MAX_LINES = 5;

function toRollupInput(s: LoadedSession): RollupInput {
  return {
    sessionId: s.frontmatter.session_id,
    ended: s.frontmatter.ended,
    track: s.frontmatter.track,
    body: s.body,
    ...(s.frontmatter.worker ? { kind: 'worker' as const, worker: s.frontmatter.worker } : {}),
  };
}

export function renderParallelSessions(sessions: LoadedSession[]): string | null {
  if (sessions.length === 0) return null;
  const workers = sessions.filter((s) => isWorkerRecord(toRollupInput(s)));
  const others = sessions.filter((s) => !workers.includes(s));
  const lines = others.map((s) => {
    const { ended, session_id, track } = s.frontmatter;
    const summary = firstLine(s.body) ?? '_(empty session body)_';
    return `- ${endedDate(ended)} (${track}, ${session_id}) — ${summary}`;
  });
  const rollup = buildWorkerRollup(workers.map(toRollupInput));
  lines.push(...renderWorkerRollup(rollup, WORKER_ROLLUP_MAX_LINES));
  return `# Parallel sessions since then\n${lines.join('\n')}`;
}

/**
 * Whether one of the initiative's push channels is agent-chat.
 *
 * Targets arrive in the three shapes `buildChannelArgs` accepts — a bare server
 * name, `server:<name>`, `plugin:<name>@<marketplace>` — so the name is matched
 * after stripping the prefix and any marketplace suffix.
 */
function hasAgentChatChannel(brief: BriefFrontmatter): boolean {
  return (brief.channels ?? []).some((raw) => {
    const name = raw.replace(/^(?:server|plugin):/, '').split('@')[0] ?? '';
    return name === 'agent-chat';
  });
}

/**
 * One line per sibling, with confidence wording matched to the lease mode.
 *
 * The distinction is the whole point of having two modes: a `launcher` lease
 * names a process we just signalled, so it can be stated as fact, while a
 * `oneshot` lease is a TTL guess about a process that left no handle behind.
 * Rendering the guess in the same voice as the fact would train the reader to
 * discount both.
 */
function renderSiblingLine(sibling: SiblingSession): string {
  const elapsed = `at ${sibling.started}`;
  const where = `in \`${sibling.cwd}\``;
  if (sibling.mode === 'launcher') {
    const pid = sibling.pid === undefined ? '' : ` (pid ${sibling.pid})`;
    return `- started ${elapsed} ${where} — launched via \`aw\`, process still running${pid}.`;
  }
  return `- bootstrapped ${elapsed} ${where} — no live process to confirm, so it may have already exited.`;
}

const SIBLING_HEADING = '# Another session may already be live on this initiative';

/**
 * Warn, at t=0, that this may be the second session on the same initiative.
 *
 * Pure: the probe happens in `assembleBootstrap`. Renders nothing when there
 * are no siblings — with an empty list the prompt must be byte-identical to one
 * assembled without this feature at all.
 */
export function renderSiblingSessions(
  siblings: SiblingSession[],
  brief: BriefFrontmatter,
  topTaskTitle: string | undefined,
): string {
  if (siblings.length === 0) return '';
  const lines = siblings.map(renderSiblingLine);
  const topTask = topTaskTitle ? ` ("${topTaskTitle}")` : '';
  lines.push(
    `Before starting the top task${topTask}, ask the user which session owns it. ` +
      'If this is the second session, take distinct scope and record it with ' +
      '`active-work wrap --track adhoc` — not `canonical`, which would bury the ' +
      "other session's mainline thread in the next bootstrap.",
  );
  if (hasAgentChatChannel(brief)) {
    lines.push(
      'This initiative carries an agent-chat channel: register under a name that ' +
        'distinguishes you from the other session and coordinate scope there.',
    );
  }
  return `${SIBLING_HEADING}\n${lines.join('\n')}`;
}

/**
 * Surface a non-`focused` initiative state.
 *
 * Bootstrap otherwise reads identically for a paused initiative and a focused
 * one, so a session resumed on a backburnered or paused workstream picks up its
 * top task and starts executing — exactly the thing pausing it was meant to
 * stop. `restart_trigger` is included because it is the condition the operator
 * wrote down as "what would make this current again", and it is the only way
 * the session can tell whether resuming is actually warranted.
 */
export function renderBriefState(brief: BriefFrontmatter): string | null {
  if (brief.state === 'focused') return null;
  const lines: string[] = [];
  if (brief.paused_since) {
    lines.push(`Paused since ${brief.paused_since}.`);
  }
  if (brief.restart_trigger) {
    lines.push(`Restart trigger: ${brief.restart_trigger}`);
  }
  lines.push(
    `This initiative is \`${brief.state}\`, not \`focused\` — confirm with the user before treating its tasks as current work.`,
  );
  return `# Initiative state: ${brief.state}\n${lines.join('\n')}`;
}
