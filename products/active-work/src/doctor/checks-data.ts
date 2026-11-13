import nodePath from 'node:path';
import { ConfigError } from '../errors.js';
import { getActiveRoot } from '../utils/paths.js';
import { lintHashes } from '../lint/index.js';
import { listInitiativeSlugs } from '../sessions/initiatives.js';
import { loadTasks } from '../lint/load-tasks.js';
import { loadNotesFromDir } from '../notes/note-file.js';
import { NOTE_TITLE_MAX_LENGTH } from '../schemas/note.js';
import { sweepAllLeases } from '../sessions/lease.js';
import { openGraph, type WorkspaceGraph } from '../session-index/graph.js';
import { checkWorkspaceIndex, type WorkspaceIndexHealth } from '../workspace-index/doctor.js';
import {
  deriveOpenLoops,
  findSessionIssues,
  type DanglingKind,
  type DanglingResolve,
  type MalformedSession,
} from '../sessions/open-loops.js';
import type { DoctorCheck, DoctorDeps } from './index.js';

/** Each rejection kind has a different remedy, so each gets its own sentence. */
const DANGLING_REMEDY: Record<DanglingKind, string> = {
  missing: 'no such next_step — fix or drop the ref',
  'not-prior':
    'target session ended at or after the resolver, so the close was rejected — re-file the resolve from a later session',
  self: 'a session cannot resolve its own loop — resolve it from a later session',
};

function describeDangling(kind: DanglingKind, entries: string[]): string {
  return `${DANGLING_REMEDY[kind]}: ${entries.join(', ')}`;
}

function openLoopsCheck(byKind: Map<DanglingKind, string[]>): DoctorCheck {
  if (byKind.size === 0) {
    return { name: 'open-loops', status: 'ok', detail: 'no dangling resolves' };
  }
  const parts = [...byKind.entries()].map(([kind, refs]) => describeDangling(kind, refs));
  return { name: 'open-loops', status: 'warn', detail: parts.join('; ') };
}

function taskRefsCheck(entries: string[]): DoctorCheck {
  if (entries.length === 0) {
    return { name: 'task-refs', status: 'ok', detail: 'every next_steps task ref resolves' };
  }
  return {
    name: 'task-refs',
    status: 'warn',
    // Mirrors dangling resolves, but for the other half of the ledger: unlike
    // a bad `resolves` ref, a bad `next_steps` ref is never rejected — the
    // loop just stays open and silent forever.
    detail: `next_steps reference a task that does not exist: ${entries.join('; ')}`,
  };
}

/** `kind: 'task'` open loops whose `ref` names no task in this initiative. */
async function collectBadTaskRefs(
  slug: string,
  initiativeDir: string,
  now: Date,
): Promise<string[]> {
  const tasks = await loadTasks(initiativeDir);
  const taskIds = new Set(tasks.map((t) => t.id));
  const loops = await deriveOpenLoops(initiativeDir, { now, tasks });
  const bad: string[] = [];
  for (const loop of loops) {
    if (loop.kind !== 'task' || loop.targetRef === undefined) continue;
    if (taskIds.has(loop.targetRef)) continue;
    bad.push(
      `${slug}/sessions/${loop.sessionFile}.md ${loop.ref} -> ${loop.targetRef} (no such task)`,
    );
  }
  return bad;
}

function sessionFilesCheck(malformed: string[]): DoctorCheck {
  if (malformed.length === 0) {
    return { name: 'session-files', status: 'ok', detail: 'every session file parses' };
  }
  return {
    name: 'session-files',
    status: 'warn',
    // These files are invisible in the ledger: their loops vanish and the loops
    // they closed come back. Only this check can surface them.
    detail: `${malformed.length} session file(s) unreadable — their loops are missing from the ledger: ${malformed.join('; ')}`,
  };
}

async function slugsShown(activeRoot: string, deps: DoctorDeps): Promise<string[]> {
  const hidden = deps.hiddenSlugs ?? new Set<string>();
  return (await listInitiativeSlugs(activeRoot)).filter((slug) => !hidden.has(slug));
}

/** An indexed path is relative to the active root, so its first segment is the initiative it sits in. */
function pathShown(deps: DoctorDeps): (relativePath: string) => boolean {
  const hidden = deps.hiddenSlugs ?? new Set<string>();
  return (relativePath) => !hidden.has(relativePath.split('/')[0]!);
}

/**
 * Walk every initiative once and report both integrity signals derivation
 * cannot express in the ledger: rejected `resolves` and unparseable sessions.
 */
export async function checkSessions(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const activeRoot = deps.activeRoot ?? getActiveRoot();
  const slugs = await slugsShown(activeRoot, deps);
  const byKind = new Map<DanglingKind, string[]>();
  const malformed: string[] = [];
  const badTaskRefs: string[] = [];
  const now = new Date();
  for (const slug of slugs) {
    const initiativeDir = nodePath.join(activeRoot, slug);
    const issues = await findSessionIssues(initiativeDir);
    for (const entry of issues.dangling) collectDangling(byKind, slug, entry);
    for (const entry of issues.malformed) malformed.push(describeMalformed(slug, entry));
    badTaskRefs.push(...(await collectBadTaskRefs(slug, initiativeDir, now)));
  }
  return [openLoopsCheck(byKind), sessionFilesCheck(malformed), taskRefsCheck(badTaskRefs)];
}

function collectDangling(
  byKind: Map<DanglingKind, string[]>,
  slug: string,
  entry: DanglingResolve,
): void {
  const line = `${slug}/sessions/${entry.sessionFile}.md resolves ${entry.ref}`;
  const existing = byKind.get(entry.kind);
  if (existing) existing.push(line);
  else byKind.set(entry.kind, [line]);
}

function describeMalformed(slug: string, entry: MalformedSession): string {
  return `${slug}/sessions/${entry.file} (${entry.reason})`;
}

function noteTitlesCheck(entries: string[]): DoctorCheck {
  if (entries.length === 0) {
    return {
      name: 'note-titles',
      status: 'ok',
      detail: `every note title is at most ${NOTE_TITLE_MAX_LENGTH} characters`,
    };
  }
  return {
    name: 'note-titles',
    status: 'warn',
    // `note.add` rejects these now, so anything here predates the bound: the
    // read path stays permissive on purpose, and this is the only place those
    // notes get named.
    detail:
      `note title longer than ${NOTE_TITLE_MAX_LENGTH} characters ` +
      `(rename the title in the file's frontmatter): ${entries.join('; ')}`,
  };
}

/** Notes whose stored title exceeds the write-time bound. */
export async function checkNoteTitles(deps: DoctorDeps): Promise<DoctorCheck> {
  const activeRoot = deps.activeRoot ?? getActiveRoot();
  const slugs = await slugsShown(activeRoot, deps);
  const overlong: string[] = [];
  for (const slug of slugs) {
    const { notes } = await loadNotesFromDir(nodePath.join(activeRoot, slug));
    for (const note of notes) {
      if (note.frontmatter.title.length <= NOTE_TITLE_MAX_LENGTH) continue;
      overlong.push(
        `${slug}/sources/notes/${note.filename} (${note.frontmatter.title.length} chars)`,
      );
    }
  }
  return noteTitlesCheck(overlong);
}

/**
 * Session leases under `<activeRoot>/.sessions/` (CC-9).
 *
 * Dead leases are swept by whoever next bootstraps the initiative, so this is
 * mostly a visibility check — but a directory that cannot be pruned means the
 * sibling warning would eventually fire on every launch forever, and that is
 * worth naming before the operator starts ignoring the warning. Never `fail`:
 * leases are advisory, and an install is not broken because one is stuck.
 */
export async function checkLeases(deps: DoctorDeps): Promise<DoctorCheck> {
  const activeRoot = deps.activeRoot ?? getActiveRoot();
  const result = await (deps.sweepLeases ?? sweepAllLeases)(activeRoot);
  const counts = `${result.live} live, ${result.pruned} pruned`;
  if (result.error) {
    return {
      name: 'session-leases',
      status: 'warn',
      detail: `could not sweep ${nodePath.join(activeRoot, '.sessions')} (${result.error}) — stale leases will keep warning every bootstrap`,
    };
  }
  return { name: 'session-leases', status: 'ok', detail: counts };
}

function artifactHashesCheck(drifted: string[]): DoctorCheck {
  if (drifted.length === 0) {
    return {
      name: 'artifact-hashes',
      status: 'ok',
      detail: 'no hand-edits detected in tracked structured artifacts',
    };
  }
  return {
    name: 'artifact-hashes',
    status: 'warn',
    detail: `hand-edited outside active-work: ${drifted.join('; ')}`,
  };
}

function workspaceIndexCheck(health: WorkspaceIndexHealth | null): DoctorCheck {
  if (health === null) {
    return { name: 'workspace-index', status: 'ok', detail: 'no index built yet' };
  }
  if (health.missing.length === 0) {
    return {
      name: 'workspace-index',
      status: 'ok',
      detail: `${health.checked} indexed refs all resolve to a file that opens`,
    };
  }
  return {
    name: 'workspace-index',
    status: 'warn',
    // Brain's whole failure, made visible: 5,013 of 5,065 notes detached on one
    // directory move and nothing noticed, because nothing checked.
    detail:
      `${health.missing.length} of ${health.checked} indexed refs point at a file that no longer opens ` +
      `(run \`active-work miner refresh\`): ${health.missing.slice(0, 5).join('; ')}`,
  };
}

/** Indexed refs whose file is gone (TP-24). Absent index is not a fault — it is rebuildable. */
export async function checkWorkspaceIndexRefs(deps: DoctorDeps): Promise<DoctorCheck> {
  const activeRoot = deps.activeRoot ?? getActiveRoot();
  let graph: WorkspaceGraph;
  try {
    graph = openGraph();
  } catch (err) {
    // A graph from a newer active-work is a fault to report, not an index to rebuild.
    if (err instanceof ConfigError)
      return { name: 'workspace-index', status: 'fail', detail: err.message };
    return workspaceIndexCheck(null);
  }
  try {
    return workspaceIndexCheck(await checkWorkspaceIndex(graph, activeRoot, pathShown(deps)));
  } finally {
    graph.db.close();
  }
}

/** Structured artifacts (tasks/*.yml, artifacts.yml, brief.md) whose content no longer matches the last CLI write (AW-66). */
export async function checkArtifactHashes(deps: DoctorDeps): Promise<DoctorCheck> {
  const activeRoot = deps.activeRoot ?? getActiveRoot();
  const slugs = await slugsShown(activeRoot, deps);
  const drifted: string[] = [];
  for (const slug of slugs) {
    const findings = await lintHashes(slug, nodePath.join(activeRoot, slug));
    drifted.push(...findings.map((f) => `${slug}/${f.file}`));
  }
  return artifactHashesCheck(drifted);
}

