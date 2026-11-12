import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isAgentVisible } from '@titan-design/pm';
import { parseFrontmatter } from '../utils/gray-matter-io.js';
import { listInitiativeSlugsOrEmpty } from './initiatives.js';

/**
 * Agent-facing readers ask here, never the charter, whether an initiative may be served
 * (TP-5453 P6). The brief's own `visibility` decides; `isAgentVisible` fails closed.
 */

/** The brief's front matter, or null when the file is missing or will not parse. */
async function readBriefFrontmatter(activeRoot: string, slug: string): Promise<unknown> {
  try {
    return parseFrontmatter(await fs.readFile(path.join(activeRoot, slug, 'brief.md'), 'utf8')).data;
  } catch {
    return null;
  }
}

export async function initiativeIsAgentVisible(activeRoot: string, slug: string): Promise<boolean> {
  return isAgentVisible({ slug, brief: await readBriefFrontmatter(activeRoot, slug) });
}

/** Rows tied to no initiative (null) stay servable; an initiative with no directory does not. */
export type AgentVisibility = (initiative: string | null) => boolean;

export async function loadAgentVisibility(activeRoot: string): Promise<AgentVisibility> {
  const slugs = await listInitiativeSlugsOrEmpty(activeRoot);
  const verdicts = await Promise.all(slugs.map((slug) => initiativeIsAgentVisible(activeRoot, slug)));
  const visible = new Set(slugs.filter((_, i) => verdicts[i]));
  return (initiative) => initiative === null || visible.has(initiative);
}
