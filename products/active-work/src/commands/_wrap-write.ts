import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BriefFrontmatterSchema } from '../schemas/brief.js';
import type { WorkerRecord } from '../schemas/worker-record.js';
import { writeSessionFile } from '../sessions/session-file.js';
import { findDanglingResolves, type DanglingKind } from '../sessions/open-loops.js';
import { writeNoteFile } from '../notes/note-file.js';
import { loadTasks } from '../bootstrap/load.js';
import { recordUnrecorded, sweepInitiative, type SweepResult } from '../wrap/sweep.js';
import { readRawFrontmatter, writeFrontmatter } from '../utils/gray-matter-io.js';
import { today } from '../utils/today.js';
import { ValidationError } from '../errors.js';
import type { Args, Filed, Ledger, NoteInput, RejectedResolve } from './_wrap-args.js';

/**
 * A fabricated id is worse than no id: it reads as filed work that does not
 * exist. Only existence is checkable here, and the message says so rather than
 * implying the ids were confirmed to be this session's.
 */
export async function verifyTaskIds(initiativeDir: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const known = new Set((await loadTasks(initiativeDir)).tasks.map((task) => task.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length === 0) return;
  throw new ValidationError(
    `--tasks-filed names ${unknown.length} id(s) with no task file in this initiative: ` +
      `${unknown.join(', ')}. File the task, then wrap. (Only existence is checked — ` +
      'that a task was created during this session is not verifiable.)',
  );
}

async function stampBriefUpdated(briefPath: string): Promise<string> {
  const updated = today();
  const { frontmatter, body } = await readRawFrontmatter(briefPath);
  frontmatter.updated = updated;
  await writeFrontmatter(briefPath, frontmatter, body, BriefFrontmatterSchema);
  return updated;
}

/**
 * Write the session file, then bump `brief.updated`. If the brief write fails
 * the session file is removed again, so a wrap is all-or-nothing rather than
 * merely discouraged from being partial.
 */
export async function writeWrap(
  args: Args,
  briefPath: string,
  body: string,
  ledger: Ledger,
  worker: WorkerRecord | undefined,
): Promise<{ path: string; filename: string; updated: string }> {
  const session = await writeSessionFile({
    slug: args.slug,
    session_id: args.session_id,
    started: args.started,
    ended: args.ended,
    track: args.track,
    body,
    next_steps: ledger.next_steps,
    resolves: ledger.resolves,
    ...(args.no_loops === true ? { no_loops: true as const } : {}),
    ...(args.parent_session_id ? { parent_session_id: args.parent_session_id } : {}),
    ...(worker === undefined ? {} : { worker }),
  });
  try {
    const updated = await stampBriefUpdated(briefPath);
    return { ...session, updated };
  } catch (err) {
    await fs.rm(session.path, { force: true });
    throw err;
  }
}

/** Note paths written, so a later failure can unwind them. */
export async function fileNotes(
  initiativeDir: string,
  notes: NoteInput[],
  created: string,
): Promise<string[]> {
  const written: string[] = [];
  for (const note of notes) {
    const result = await writeNoteFile(
      initiativeDir,
      {
        kind: note.kind,
        title: note.title,
        created,
        ...(note.tags === undefined ? {} : { tags: note.tags }),
      },
      note.body,
    );
    written.push(result.path);
  }
  return written;
}

const NOTHING_RECORDED = { worktrees: 0, branches: 0, stashes: 0 };

/**
 * Dirty trees and unpushed branches cannot be recorded anywhere — only the tree
 * itself knows. They are surfaced as warnings rather than gating the wrap.
 */
function warnUnrecordable(sweep: SweepResult, warnings: string[]): void {
  for (const tree of sweep.dirty) {
    warnings.push(
      tree.files_changed === null
        ? `Could not read the working tree in ${tree.path} (${tree.repo}); it may hold uncommitted work. Check it before relying on this wrap.`
        : `Uncommitted work in ${tree.path} (${tree.repo}): ${tree.files_changed} file(s) changed.`,
    );
  }
  for (const branch of sweep.unpushed) {
    warnings.push(
      `${branch.branch} in ${branch.path} (${branch.repo}) is ${branch.ahead} commit(s) ahead of its remote.`,
    );
  }
}

/**
 * Record whatever git state the initiative has not written down. The operator
 * chose recording over refusing: a wrap never fails because a worktree was
 * untracked, only because writing the record itself failed.
 *
 * MUST run inside the initiative lock — `recordUnrecorded` takes none of its own.
 */
export async function sweepAndRecord(
  slug: string,
  activeRoot: string,
  warnings: string[],
): Promise<typeof NOTHING_RECORDED> {
  let sweep: SweepResult;
  try {
    sweep = await sweepInitiative(slug, activeRoot, process.cwd());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnings.push(`Could not sweep git state for unrecorded artifacts: ${reason}`);
    return NOTHING_RECORDED;
  }
  warnUnrecordable(sweep, warnings);
  return recordUnrecorded(slug, activeRoot, sweep.unrecorded);
}

/**
 * Which `resolves` entries of the session just written closed nothing, and why.
 *
 * Derived by re-running the canonical derivation over the initiative rather
 * than re-implementing the rules: a second classifier that disagreed with
 * `deriveOpenLoops` would report a close that bootstrap still shows as open.
 */
export async function rejectedResolves(
  initiativeDir: string,
  filename: string,
): Promise<RejectedResolve[]> {
  const stem = filename.replace(/\.md$/, '');
  const dangling = await findDanglingResolves(initiativeDir);
  return dangling
    .filter((entry) => entry.sessionFile === stem)
    .map(({ ref, kind }) => ({ ref, kind }));
}

const REMEDY: Record<DanglingKind, string> = {
  missing: 'no loop carries that ref — check the session-file stem and the next_steps id',
  'not-prior':
    'the loop was opened by a session that did not end strictly before this one — re-file the resolve from a later session',
  self: 'a session cannot close a loop it opened — carry it as a next_step instead',
};

/**
 * The session is on disk by the time this runs and the message says so: an
 * agent that typo'd one ref should re-file that ref, not re-run the wrap and
 * duplicate the narrative.
 *
 * This rides `ctx.warnings` rather than a thrown error. Throwing discarded the
 * receipt — the one case `ready_to_end: false` and `resolves_rejected[]` exist
 * to describe was also the one case no caller could read them, leaving the
 * machine-readable half of the contract available only as prose to parse.
 */
export function rejectionReport(
  sessionPath: string,
  rejected: RejectedResolve[],
  total: number,
): string {
  const lines = rejected.map((r) => `  - ${r.ref} (${r.kind}): ${REMEDY[r.kind]}`);
  return (
    `Session written to ${sessionPath}, but ${rejected.length} of ${total} ` +
    `--resolves entries closed no loop:\n${lines.join('\n')}\n` +
    'The session file and brief.updated are committed, so ready_to_end is false: ' +
    're-file only the rejected refs from a later session.'
  );
}

export function filesUpdated(
  initiativeDir: string,
  notePaths: string[],
  recorded: Filed,
): string[] {
  const files = ['brief.md'];
  if (recorded.worktrees + recorded.branches + recorded.stashes > 0) {
    files.push('artifacts.yml');
  }
  return files.concat(notePaths.map((p) => path.relative(initiativeDir, p)));
}
