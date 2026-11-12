import type { LoadedNote, LoadedNotes } from '../notes/note-file.js';
import { readIfSuffix } from '../notes/read-if.js';
import {
  normalizePrRef,
  type LoadedSession,
  type MalformedSession,
  type OpenLoop,
  type ResolvedLoop,
} from '../sessions/open-loops.js';
import type { NoteRanking } from './rank-notes.js';
import { renderSeeLine, type LoopHit } from './loop-context.js';
import { renderHiddenLoopsNote, type BootstrapFacet } from './facet.js';
import { endedDate } from './render-sessions.js';
import type { MalformedTask } from './prompt.js';

/**
 * Notes are capped by count, never by age. A process lesson from six months ago
 * is precisely the one about to be re-learned the hard way, so it must not
 * scroll out of the bootstrap the way "recently done" does. The cap keeps the
 * section bounded; one compact line each keeps it cheap.
 */
export const DURABLE_NOTES_LIMIT = 12;

function renderNoteLine(note: LoadedNote): string {
  const { kind, title, created, read_if: readIf } = note.frontmatter;
  return `- [${kind}] ${title} (${created})${readIfSuffix(readIf)}`;
}

export function renderDurableNotes(
  loaded: LoadedNotes,
  ranking: NoteRanking,
  slug: string,
): string | null {
  const { malformed } = loaded;
  const notes = ranking.local;
  if (notes.length === 0 && malformed.length === 0) return null;
  const shown = notes.slice(0, DURABLE_NOTES_LIMIT);
  const lines = shown.map(renderNoteLine);
  const overflow = notes.length - shown.length;
  // The heading and the overflow both have to say which ordering this is.
  // "Newest 12 of 34" is a lie when the list is ranked, and a reader who
  // cannot tell why a note leads cannot judge whether the ordering is working.
  const ordering = ranking.ranked ? 'most relevant' : 'newest';
  if (overflow > 0) {
    const rest = ranking.ranked ? 'more' : 'older';
    lines.push(`(+${overflow} ${rest} — \`active-work note list ${slug}\`)`);
  }
  if (malformed.length > 0) {
    lines.push(
      `(${malformed.length} note file(s) unreadable — run \`active-work note list ${slug}\`)`,
    );
  }
  const heading =
    overflow > 0
      ? `# Durable notes (${ordering} ${shown.length} of ${notes.length})`
      : `# Durable notes (${notes.length})`;
  return `${heading}\n${lines.join('\n')}`;
}

/**
 * Notes from other initiatives that bear on this one.
 *
 * Every note is labelled with the initiative it came from, because an
 * unlabelled foreign note is worse than none: the reader cannot tell why it is
 * there or how much to trust it here. Absent entirely when nothing clears the
 * floor, which is most sessions.
 */
export function renderForeignNotes(ranking: NoteRanking): string | null {
  if (ranking.foreign.length === 0) return null;
  const lines = ranking.foreign.map(
    (note) => `- [from \`${note.initiative}\`] ${note.title} (\`${note.ref}\`)`,
  );
  return `# From other initiatives\n${lines.join('\n')}`;
}

/**
 * An empty ledger has two very different meanings and the operator has to be
 * able to tell them apart: a session that ran `wrap --no-loops` positively
 * asserted nothing was hanging, whereas an empty derivation may simply mean
 * nobody ever filed a ledger. Rendering both as "nothing hanging" makes the
 * assertion worthless, which is what `no_loops` exists to prevent.
 */
function renderNoOpenLoops(newestSession: LoadedSession | undefined): string {
  if (newestSession?.frontmatter.no_loops === true) {
    return `Nothing hanging — the ${endedDate(newestSession.ended)} session asserted the ledger is clear.`;
  }
  return 'Nothing hanging — no unresolved loops, but no session has asserted the ledger is clear.';
}

/**
 * A file that would not parse both drops the loops it opened and re-opens the
 * ones it closed, so a silently short ledger is worse than a noisy one.
 */
function malformedNote(malformed: MalformedSession[]): string {
  if (malformed.length === 0) return '';
  return ` (${malformed.length} session file(s) unreadable — run \`active-work doctor\`)`;
}

/**
 * A task file that would not parse is missing from the list entirely, so the
 * heading has to say so — otherwise a shorter list looks like less work.
 */
export function malformedTaskNote(malformed: MalformedTask[]): string {
  if (malformed.length === 0) return '';
  const files = malformed.map((m) => m.file).join(', ');
  return ` — ${malformed.length} task file(s) unreadable (${files}); run \`active-work doctor\``;
}

/**
 * Whether the text already opens with `ref`, so prefixing would print it twice.
 *
 * Only a match at the head counts. A loop filed against `AW-65` whose text
 * opens `AW-59 is done` is a ledger/text *disagreement* the operator needs to
 * see, not noise to collapse — suppressing there would hide which task the loop
 * actually concerns. The trailing boundary check keeps `AW-2` from matching text
 * about `AW-28` (AW-71).
 */
function textOpensWithRef(text: string, ref: string, kind: OpenLoop['kind']): boolean {
  const head = text.replace(/^\s*(PR\s*)?#?/i, '');
  // A pasted `.../pull/57` at the head is the same restatement in another form.
  if (kind === 'pr' && normalizePrRef(head.split(/\s/)[0] ?? '') === ref) return true;
  if (!head.toLowerCase().startsWith(ref.toLowerCase())) return false;
  const next = head.charAt(ref.length);
  return next === '' || !/[A-Za-z0-9]/.test(next);
}

/** Prefix the loop text with its target so a task/PR loop is actionable at a glance. */
export function loopLabel(loop: OpenLoop): string {
  if (loop.targetRef === undefined) return loop.text;
  const ref = loop.kind === 'pr' ? normalizePrRef(loop.targetRef) : loop.targetRef;
  if (textOpensWithRef(loop.text, ref, loop.kind)) return loop.text;
  return loop.kind === 'pr' ? `PR #${ref} ${loop.text}` : `${ref} ${loop.text}`;
}

interface LoopRelated {
  slug: string;
  hits: Map<string, LoopHit[]>;
}

/**
 * Loops are already unresolved and oldest-first; `ageDays` comes from the
 * derivation so the render never recomputes time. The full `ref` is printed
 * rather than an abbreviated session id because it is the handle `wrap
 * --resolve` takes. A loop's `see:` lines sit under it because the reader
 * works loop by loop (TP-85); a loop with none renders exactly as before.
 */
function renderOpenLoops(
  loops: OpenLoop[],
  malformed: MalformedSession[],
  newestSession: LoadedSession | undefined,
  related: LoopRelated,
): string {
  const note = malformedNote(malformed);
  if (loops.length === 0) {
    return `# Open loops${note}\n${renderNoOpenLoops(newestSession)}`;
  }
  const labels = loops.map(loopLabel);
  const ageWidth = Math.max(...loops.map((l) => String(l.ageDays).length));
  const labelWidth = Math.max(...labels.map((l) => l.length));
  const lines = loops.map((loop, i) => {
    const age = `[${String(loop.ageDays).padStart(ageWidth)}d]`;
    const label = labels[i].padEnd(labelWidth);
    const from = loop.openedAt.slice(0, 10);
    const see = (related.hits.get(loop.ref) ?? []).map((hit) => renderSeeLine(hit, related.slug));
    return [`- ${age} ${label}   (from ${from}, ref ${loop.ref})`, ...see].join('\n');
  });
  const oldest = loops[0].ageDays;
  return `# Open loops (${loops.length} hanging, oldest ${oldest}d)${note}\n${lines.join('\n')}`;
}

/** `renderOpenLoops`, plus a pointer to the loops a facet hid. */
export function renderFacetedLoops(
  loops: OpenLoop[],
  hidden: number,
  malformed: MalformedSession[],
  newestSession: LoadedSession | undefined,
  related: LoopRelated,
): string {
  const hiddenNote = renderHiddenLoopsNote(hidden, related.slug);
  if (hiddenNote === null) return renderOpenLoops(loops, malformed, newestSession, related);
  const body =
    loops.length === 0
      ? `# Open loops${malformedNote(malformed)}\nNo open loops in this facet.`
      : renderOpenLoops(loops, malformed, newestSession, related);
  return `${body}\n${hiddenNote}`;
}

/** How the header names what the session opened on. */
export function sessionTarget(slug: string, title: string, facet: BootstrapFacet | undefined): string {
  const base = `\`${slug}\` (${title})`;
  return facet ? `${base}, scoped to facet \`${facet.name}\`` : base;
}

export function renderInitOpening(slug: string, title: string): string {
  return `Starting the first session on ${title} (\`${slug}\`). This initiative was just scaffolded and its brief is empty: the only thing on disk is a placeholder brief. Your job in this session is to set it up with the user before any other work.`;
}

/** Only verbs that exist in the CLI; `edit` opens the operator's editor, so the body is edited in place. */
export function renderInitClosing(slug: string, briefPath: string): string {
  return [
    `This is an init session. Start by asking the user what this initiative is and why it exists, then replace the placeholder body of ${briefPath} (below its frontmatter) with a \`Why\` section and what done looks like. Change frontmatter only through \`active-work set ${slug} <field> <value>\`, for example \`ship_target\` or \`owner\` if the user gives them.`,
    `Ask whether a worktree, repo or project directory already exists for this work. In practice it often will not, since this is usually run from a fresh terminal at the start of new work. If one does, register it with \`active-work worktree set ${slug} <path>\`, and record a branch worth tracking with \`active-work artifact add-branch ${slug} --repo <repo> --name <branch>\`.`,
    `If the user has documents or notes that belong with the initiative, file them with \`active-work source add ${slug} <file>\`. File the first tasks with \`active-work task add ${slug} --title <title> --done-when <what done looks like, 40+ chars>\`.`,
    `Close out with \`active-work wrap ${slug}\`; the default \`canonical\` track is correct for a first session.`,
  ].join(' ');
}

const WRAP_DIRECTIVE =
  'Update tasks via `active-work task done` and close the session out via `active-work wrap` when wrapping up — it records the session, files the loops you leave open, and stamps the brief in one step.';

/**
 * A hanging loop is thread continuity nobody else will pick up, so it outranks
 * the general backlog — the backlog is still there next session, whereas the
 * context that makes a loop cheap to close decays.
 *
 * The loop-first half is only emitted when the ledger actually has entries:
 * with zero loops the render above already said "nothing hanging", and telling
 * a session to triage loops would send it hunting for something that isn't
 * there.
 */
export function renderClosingInstruction(openLoops: OpenLoop[]): string {
  if (openLoops.length === 0) {
    return `Work the top task unless redirected. ${WRAP_DIRECTIVE}`;
  }
  const count = openLoops.length;
  const noun = count === 1 ? 'loop' : 'loops';
  const verb = count === 1 ? 'is' : 'are';
  return (
    `Start with the open ${noun}: ${count} ${verb} still hanging from prior sessions, ` +
    `and unfinished threads take precedence over the backlog. Work them first, citing each ` +
    `one by the \`ref\` printed under "Open loops", and pass every loop you settle to ` +
    `\`active-work wrap --resolves\` with outcome \`done\` or \`abandoned\` — deciding not to ` +
    `do a loop still closes it. Once the loops are handled, or if the user redirects, work ` +
    `the top task by priority. ${WRAP_DIRECTIVE}`
  );
}

/**
 * Only abandonments are rendered, and only recent ones. A loop closed `done`
 * needs no explanation — the work happened. A loop closed `abandoned` is a
 * decision not to do something, and a future session that cannot see it will
 * propose the abandoned thing again.
 */
export function renderAbandonedLoops(resolved: ResolvedLoop[], windowDays: number): string | null {
  const abandoned = resolved.filter(
    (loop) => loop.outcome === 'abandoned' && loop.ageDays <= windowDays,
  );
  if (abandoned.length === 0) return null;
  const lines = abandoned.map((loop) => {
    const head = `- ${loop.text} (dropped ${loop.closedAt.slice(0, 10)})`;
    return loop.note ? `${head}\n  why: ${loop.note}` : head;
  });
  return `# Abandoned in the last ${windowDays} days (${abandoned.length})\n${lines.join('\n')}`;
}
