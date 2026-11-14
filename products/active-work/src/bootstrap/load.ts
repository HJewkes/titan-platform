import path from 'node:path';
import { readInitiativeTasks } from '@titan-design/pm/node';
import { BriefFrontmatterSchema, type BriefFrontmatter } from '../schemas/brief.js';
import { ArtifactsSchema, type Artifacts } from '../schemas/artifacts.js';
import {
  loadSessionsFromDir,
  type LoadedSession,
  type LoadedSessions,
} from '../sessions/open-loops.js';
import { readYaml } from '../utils/yaml-io.js';
import { NotFoundError } from '../errors.js';
import { readMarkdownWithSchema } from '../utils/markdown-schema.js';
import type { LoadedTasks } from './prompt.js';

/**
 * Order sessions newest first, breaking `ended` ties on `started` so a long
 * mainline session that overlaps a short parallel one still sorts ahead of it.
 */
function compareSessionsNewestFirst(a: LoadedSession, b: LoadedSession): number {
  const endedDelta =
    new Date(b.frontmatter.ended).getTime() - new Date(a.frontmatter.ended).getTime();
  if (endedDelta !== 0) return endedDelta;
  return new Date(b.frontmatter.started).getTime() - new Date(a.frontmatter.started).getTime();
}

/**
 * Every session for an initiative, newest first, regardless of track.
 *
 * Parsing is delegated to `loadSessionsFromDir` — the same loader derivation
 * uses — so bootstrap can never render a session whose loops the ledger
 * dropped, or vice versa. Unparseable files are not skipped silently: they
 * come back as `malformed` and are surfaced in the Open loops heading.
 */
export async function loadSessionsNewestFirst(initiativeDir: string): Promise<LoadedSessions> {
  const { sessions, malformed } = await loadSessionsFromDir(initiativeDir);
  return { sessions: [...sessions].sort(compareSessionsNewestFirst), malformed };
}
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read every task file under `initiativeDir/tasks`, through the pm reader.
 *
 * A file that would not parse is *not* the same as a task that does not exist:
 * dropping it silently shrinks the open list, so the next session works a stale
 * top task and never learns why. Malformed entries travel back to the caller
 * the way `loadSessionsFromDir` returns `malformed`; callers that only need the
 * tasks take `.tasks` and ignore them.
 */
export async function loadTasks(initiativeDir: string): Promise<LoadedTasks> {
  const { tasks, unparsed } = await readInitiativeTasks(
    path.dirname(initiativeDir),
    path.basename(initiativeDir),
  );
  return {
    tasks: tasks.map((row) => row.task),
    malformed: unparsed.map(({ file, reason }) => ({ file: path.posix.basename(file), reason })),
  };
}

interface LoadedArtifacts {
  artifacts: Artifacts;
  /** Set only when `artifacts.yml` exists but could not be read or parsed. */
  error?: string;
}

function isMissingFile(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

/**
 * Read `artifacts.yml`, keeping "no artifacts yet" distinct from "the file is
 * broken".
 *
 * Both used to render as an empty ledger, which is the worst possible outcome:
 * a corrupted file quietly claims there are no open branches or stashes, and
 * the session starts by assuming clean ground it does not have.
 */
export async function loadArtifacts(initiativeDir: string): Promise<LoadedArtifacts> {
  const artifactsPath = path.join(initiativeDir, 'artifacts.yml');
  const empty: Artifacts = { branches: [], stashes: [], worktrees: [] };
  try {
    return { artifacts: await readYaml(artifactsPath, ArtifactsSchema) };
  } catch (err) {
    if (isMissingFile(err)) return { artifacts: empty };
    return { artifacts: empty, error: describe(err) };
  }
}

/**
 * Keep the first `max` non-blank lines of `body`, marking the cut.
 *
 * The marker is not decoration: an excerpt that ends mid-thought reads as the
 * whole thought, so the reader has to be told both that content was dropped and
 * which file holds the rest. `source` is a real path for exactly that reason.
 */
export function truncateLines(body: string, max: number, source: string): string {
  const lines = body.split('\n');
  const trimmed: string[] = [];
  let count = 0;
  let consumed = 0;
  for (const line of lines) {
    if (count >= max) break;
    trimmed.push(line);
    consumed++;
    if (line.trim().length > 0) count++;
  }
  const dropped = lines.slice(consumed).filter((l) => l.trim().length > 0).length;
  const kept = trimmed.join('\n').replace(/\s+$/, '');
  if (dropped === 0) return kept;
  return `${kept}\n…(+${dropped} lines — see ${source})`;
}
export async function loadBrief(
  initiativeDir: string,
  slug: string,
): Promise<{ frontmatter: BriefFrontmatter; body: string }> {
  const briefPath = path.join(initiativeDir, 'brief.md');
  try {
    return await readMarkdownWithSchema(briefPath, BriefFrontmatterSchema);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new NotFoundError(`Initiative '${slug}' has no readable brief.md (${reason})`);
  }
}
