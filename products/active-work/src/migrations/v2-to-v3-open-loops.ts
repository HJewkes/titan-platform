import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BriefFrontmatterSchema } from '../schemas/brief.js';
import { writeSessionFile } from '../sessions/session-file.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { writeFrontmatter } from '../utils/gray-matter-io.js';
import {
  HANDOFF_ARCHIVE,
  HANDOFF_FILE,
  planV2ToV3,
  type InitiativePlan,
  type MigrationPlan,
  type SessionPlan,
} from './v2-to-v3-plan.js';
import { KNOWN_REPAIRS, applyRepair } from './v3-repairs.js';
import type { Migration } from './types.js';

/**
 * v2 → v3 (AW-38): retire `handoff.md` in favour of the session open-loops
 * ledger.
 *
 * Per initiative, driven entirely by the hand-authored proposal data file:
 * - write a back-dated `track: sidecar` session carrying the handoff's
 *   next-actions as `next_steps`, so they enter the ledger and start aging
 *   from their real last-touch;
 * - where the proposal marks a loop `abandoned`, write a *second* sidecar
 *   session, stamped later, whose `resolves` closes it (see below);
 * - repair known-broken brief fields, then backfill `task_seq`;
 * - copy `handoff.md` to `sources/handoff-archive.md`, then delete it;
 * - repair the known-malformed session files (see `v3-repairs.ts`).
 *
 * **This module writes sessions via `writeSessionFile` directly rather than
 * through `wrap`, which `SKILL.md` otherwise names as the only session
 * writer.** `wrap` stamps `brief.updated = today()`. Running it 17 times would
 * mark every initiative touched today and destroy the exact staleness signal
 * the back-dating exists to preserve. This is the sanctioned exception; no
 * other caller should copy it.
 *
 * **Why abandonment takes a second session.** A loop that was already dead
 * when the handoff was written must still be *opened* — the ledger's job is to
 * show that it existed — and then closed by a decision that is itself dated.
 * Migrating it as live would leave a loop whose own text reads "do not chase"
 * aging in the ledger forever and tripping the 30-day warning. Since only a
 * strictly later session may resolve an earlier one's loops, the closing
 * session is stamped with the proposal's `abandoned_at` — a fixed value, not
 * the clock, because the filename derives from it and idempotence keys on the
 * exact path.
 *
 * Two-phase by construction: `planV2ToV3` builds and schema-validates every
 * initiative in memory and throws on the first problem; nothing is written
 * until the whole batch passes. A rejected `session_id` therefore fails before
 * anything lands rather than half way through, which matters because a
 * half-run leaves `.schema-version` un-bumped and the next CLI invocation
 * re-runs from the top.
 *
 * Idempotent by exact target path: every synthetic session has a deterministic
 * `started` + `session_id`, so its filename is reproducible and an existing
 * file is a skip — checked per session, so an interrupted run that wrote the
 * opening session but not the abandonment one completes correctly.
 * `writeSessionFile`'s own de-duplication (which appends `-1`) is deliberately
 * never allowed to fire; it would duplicate every migrated loop under fresh
 * refs on a re-run.
 *
 * Synthetic sessions never set `no_loops`. An empty ledger here means "the
 * handoff had nothing extractable", not "the operator confirmed nothing is
 * hanging", and the migration is not entitled to make the second claim.
 */

async function archiveHandoff(initiativeDir: string): Promise<void> {
  const source = path.join(initiativeDir, HANDOFF_FILE);
  const target = path.join(initiativeDir, HANDOFF_ARCHIVE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
  await fs.rm(source);
}

async function writePlannedSession(
  activeRoot: string,
  slug: string,
  session: SessionPlan,
): Promise<void> {
  const fm = session.frontmatter;
  await writeSessionFile({
    slug,
    activeRoot,
    session_id: fm.session_id,
    started: fm.started,
    ended: fm.ended,
    track: fm.track,
    next_steps: fm.next_steps,
    resolves: fm.resolves,
    body: session.body,
  });
}

async function applyInitiative(activeRoot: string, plan: InitiativePlan): Promise<void> {
  const initiativeDir = path.join(activeRoot, plan.slug);
  await withFileLock(path.join(initiativeDir, '.lock'), async () => {
    // Ordered: the opening session must exist before the one that resolves it.
    for (const session of plan.sessions) {
      if (session.exists) continue;
      await writePlannedSession(activeRoot, plan.slug, session);
    }
    if (plan.brief !== null) {
      await writeFrontmatter(
        path.join(initiativeDir, 'brief.md'),
        plan.brief.frontmatter,
        plan.brief.body,
        BriefFrontmatterSchema,
      );
    }
    if (plan.handoff === 'archive-and-remove') {
      await archiveHandoff(initiativeDir);
    }
  });
}

/** Phase two. Writes only what phase one already validated. */
export async function applyV2ToV3(activeRoot: string, plan: MigrationPlan): Promise<void> {
  for (const initiative of plan.initiatives) {
    await applyInitiative(activeRoot, initiative);
  }
  for (const repair of plan.repairs) {
    await applyRepair(activeRoot, repair);
  }
}

export const v2ToV3OpenLoops: Migration = {
  from: 2,
  to: 3,
  description: 'Retire handoff.md into synthetic back-dated open-loop sessions',
  async run(activeRoot: string): Promise<void> {
    const plan = await planV2ToV3(activeRoot);
    await applyV2ToV3(activeRoot, plan);
  },
};

export { KNOWN_REPAIRS };
export { planV2ToV3 };
