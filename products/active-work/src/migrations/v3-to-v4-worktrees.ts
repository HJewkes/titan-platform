import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isRecord } from '@titan-design/rpc-protocol/narrow';
import YAML from 'yaml';
import { z } from 'zod';
import { ArtifactsSchema, WorktreeEntrySchema, type WorktreeEntry } from '../schemas/artifacts.js';
import { writeYaml } from '../utils/yaml-io.js';
import { atomicWrite } from '../utils/fs-atomic.js';
import { parseFrontmatter, stringifyFrontmatter } from '../utils/gray-matter-io.js';
import type { Migration } from './types.js';

/**
 * v3 → v4 (AW-67): move `brief.worktrees` into `artifacts.yml`.
 *
 * A worktree had two homes: a curated map in the brief keyed by label, and the
 * list `wrap` sweeps from git. They now share one list, with `name` marking the
 * entries an operator registered — see `src/schemas/artifacts.ts`.
 *
 * Per initiative:
 * - each `brief.worktrees[label]` becomes an `artifacts.worktrees[]` entry with
 *   `name: label` and its `default` flag preserved
 * - a swept entry already at that path is *promoted* in place rather than
 *   duplicated, so the pairing survives a wrap that ran before the migration
 * - `repo` is required by the schema and the brief never carried one, so a
 *   promoted entry keeps the repo the sweep found and a fresh entry falls back
 *   to its own path
 * - `worktrees` is removed from the brief frontmatter
 *
 * Idempotent: a brief with no `worktrees` key is left untouched, and a second
 * run finds nothing to move. Only the frontmatter is rewritten; brief prose is
 * preserved byte-for-byte.
 */

const WorktreeListSchema = z.array(WorktreeEntrySchema);

/** Same-path comparison without tilde expansion surprises. */
function normalize(value: string): string {
  const expanded = value.startsWith('~')
    ? path.join(process.env.HOME ?? '', value.slice(1))
    : value;
  return path.resolve(expanded);
}

function toEntries(raw: unknown): Array<{ name: string; path: string; default: boolean }> {
  if (!isRecord(raw)) return [];
  const out: Array<{ name: string; path: string; default: boolean }> = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const wtPath = value.path;
    if (typeof wtPath !== 'string' || wtPath.length === 0) continue;
    out.push({ name, path: wtPath, default: value.default === true });
  }
  return out;
}

/**
 * Merge migrated entries into whatever the sweep already recorded. At most one
 * `default` survives: the brief could only express one, but a promoted entry
 * plus a stale flag elsewhere could otherwise produce two and fail validation.
 */
function mergeWorktrees(
  existing: WorktreeEntry[],
  incoming: Array<{ name: string; path: string; default: boolean }>,
): WorktreeEntry[] {
  const out = existing.map((entry) => ({ ...entry }));
  for (const wt of incoming) {
    const match = out.find(
      (entry) => entry.name === undefined && normalize(entry.path) === normalize(wt.path),
    );
    const target = match ?? { path: wt.path, repo: wt.path };
    target.name = wt.name;
    if (wt.default) target.default = true;
    else delete target.default;
    if (!match) out.push(target);
  }
  if (out.filter((entry) => entry.default === true).length > 1) {
    let kept = false;
    for (const entry of out) {
      if (entry.default !== true) continue;
      if (kept) delete entry.default;
      kept = true;
    }
  }
  return out;
}

interface CurrentArtifacts {
  branches: unknown[];
  stashes: unknown[];
  worktrees: WorktreeEntry[];
}

type SkipReason = 'unparseable' | 'not a mapping';

/** Returns the reason for a file that exists but holds no mapping: writing over it would lose its content. */
async function readArtifacts(file: string): Promise<CurrentArtifacts | SkipReason> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return { branches: [], stashes: [], worktrees: [] };
  }
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch {
    return 'unparseable';
  }
  // An empty file parses to null and holds nothing to lose; any other non-mapping is data.
  if (raw === null || raw === undefined) return { branches: [], stashes: [], worktrees: [] };
  if (!isRecord(raw)) return 'not a mapping';
  return {
    branches: Array.isArray(raw.branches) ? raw.branches : [],
    stashes: Array.isArray(raw.stashes) ? raw.stashes : [],
    // Outside the catch on purpose: a bad entry must abort before the write, as the
    // final ArtifactsSchema.parse would. Reading it as empty would overwrite the list.
    worktrees: Array.isArray(raw.worktrees) ? WorktreeListSchema.parse(raw.worktrees) : [],
  };
}

/** Returns the skip reason, writing nothing, when the existing `artifacts.yml` is not a mapping. */
async function mergeIntoArtifacts(
  initiativeDir: string,
  incoming: Array<{ name: string; path: string; default: boolean }>,
): Promise<SkipReason | null> {
  const artifactsPath = path.join(initiativeDir, 'artifacts.yml');
  const current = await readArtifacts(artifactsPath);
  if (typeof current === 'string') return current;
  await writeYaml(
    artifactsPath,
    ArtifactsSchema.parse({
      branches: current.branches,
      stashes: current.stashes,
      worktrees: mergeWorktrees(current.worktrees, incoming),
    }),
    ArtifactsSchema,
  );
  return null;
}

interface MigrateOutcome {
  moved: number;
  skipped: SkipReason | null;
}

/** Leaves the brief and an unreadable `artifacts.yml` untouched, so a later run can retry. */
async function migrateOne(initiativeDir: string): Promise<MigrateOutcome> {
  const briefPath = path.join(initiativeDir, 'brief.md');
  let raw: string;
  try {
    raw = await fs.readFile(briefPath, 'utf8');
  } catch {
    return { moved: 0, skipped: null };
  }
  const parsed = parseFrontmatter(raw);
  const data = parsed.data;
  if (!('worktrees' in data)) return { moved: 0, skipped: null };

  const incoming = toEntries(data.worktrees);
  delete data.worktrees;

  const skipped = incoming.length > 0 ? await mergeIntoArtifacts(initiativeDir, incoming) : null;
  if (skipped !== null) return { moved: 0, skipped };

  // Rewrite the brief frontmatter only; `stringifyFrontmatter` preserves the body.
  await atomicWrite(briefPath, stringifyFrontmatter(parsed.content, data));
  return { moved: incoming.length, skipped: null };
}

async function initiativeDirs(activeRoot: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(activeRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(activeRoot, entry.name);
    try {
      await fs.access(path.join(dir, 'brief.md'));
      out.push(dir);
    } catch {
      // not an initiative
    }
  }
  return out;
}

export const v3ToV4Worktrees: Migration = {
  from: 3,
  to: 4,
  description: 'Move brief.worktrees into artifacts.yml as named worktree entries',
  async run(activeRoot: string): Promise<void> {
    const moved: string[] = [];
    for (const dir of await initiativeDirs(activeRoot)) {
      const { moved: count, skipped } = await migrateOne(dir);
      if (skipped !== null) {
        moved.push(`${path.basename(dir)}\tSKIPPED: artifacts.yml is ${skipped}, left untouched`);
      } else if (count > 0) {
        moved.push(`${path.basename(dir)}\t${count} worktree(s)`);
      }
    }
    if (moved.length === 0) return;
    const stamp = new Date().toISOString();
    await fs.appendFile(
      path.join(activeRoot, '.migrations.log'),
      moved.map((line) => `${stamp}\tv3->v4\t${line}\n`).join(''),
      'utf8',
    );
  },
};

export default v3ToV4Worktrees;
