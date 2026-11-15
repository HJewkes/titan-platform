import { promises as fs } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import type { WorkspaceGraph } from '../session-index/graph.js';
import { parseFrontmatter } from '../utils/gray-matter-io.js';
import type { MentionText } from './edges.js';
import { toAbsolute } from './refs.js';

/** A source body past this is skipped by the mention pass: a pasted log is not prose that names ids on purpose. */
const MAX_SOURCE_BYTES = 256 * 1024;

interface MentionTexts {
  texts: MentionText[];
  oversizedSources: number;
}

interface OwnerRow {
  path: string;
  ref: string;
  initiative: string;
}

/** The body, not the file: frontmatter is metadata, and `mentions` is defined over prose. */
export async function readBody(absolutePath: string): Promise<string> {
  try {
    return parseFrontmatter(await fs.readFile(absolutePath, 'utf8')).content;
  } catch {
    return '';
  }
}

/** Source bodies and task text, re-read every pass for the same reason note bodies are. */
export async function collectMentionTexts(
  activeRoot: string,
  graph: WorkspaceGraph,
): Promise<MentionTexts> {
  const sources = graph.db
    .prepare<[], OwnerRow>(
      "SELECT path, source_ref AS ref, initiative FROM source WHERE path LIKE '%.md' ORDER BY path",
    )
    .all();
  const tasks = graph.db
    .prepare<[], OwnerRow>(
      'SELECT path, task_ref AS ref, initiative FROM workspace_task ORDER BY path',
    )
    .all();
  const sourceTexts = await Promise.all(sources.map((row) => readSourceText(activeRoot, row)));
  const taskTexts = await Promise.all(
    tasks.map(async (row) => ({
      ref: row.ref,
      initiative: row.initiative,
      body: await readTaskText(toAbsolute(activeRoot, row.path)),
    })),
  );
  return {
    texts: [...sourceTexts.filter((text) => text !== 'oversized'), ...taskTexts],
    oversizedSources: sourceTexts.filter((text) => text === 'oversized').length,
  };
}

async function readSourceText(
  activeRoot: string,
  row: OwnerRow,
): Promise<MentionText | 'oversized'> {
  const absolute = toAbsolute(activeRoot, row.path);
  try {
    if ((await fs.stat(absolute)).size > MAX_SOURCE_BYTES) return 'oversized';
  } catch {
    return { ref: row.ref, initiative: row.initiative, body: '' };
  }
  return { ref: row.ref, initiative: row.initiative, body: await readBody(absolute) };
}

const TaskTextSchema = z.object({
  title: z.string().optional(),
  done_when: z.string().optional(),
  notes: z.string().optional(),
});

async function readTaskText(absolutePath: string): Promise<string> {
  try {
    const parsed = TaskTextSchema.parse(YAML.parse(await fs.readFile(absolutePath, 'utf8')));
    return [parsed.title, parsed.done_when, parsed.notes].filter(Boolean).join('\n');
  } catch {
    return '';
  }
}
