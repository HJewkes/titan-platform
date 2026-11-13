import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isAgentVisible } from '@titan-design/pm';
import type { CommandContext } from '../registry/types.js';
import { parseFrontmatter } from '../utils/gray-matter-io.js';
import { listInitiativeSlugs, listInitiativeSlugsOrEmpty } from './initiatives.js';

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

async function slugsByVisibility(activeRoot: string): Promise<{ visible: string[]; ownerOnly: string[] }> {
  const slugs = await listInitiativeSlugsOrEmpty(activeRoot);
  const verdicts = await Promise.all(slugs.map((slug) => initiativeIsAgentVisible(activeRoot, slug)));
  return {
    visible: slugs.filter((_, i) => verdicts[i]),
    ownerOnly: slugs.filter((_, i) => !verdicts[i]),
  };
}

export async function loadAgentVisibility(activeRoot: string): Promise<AgentVisibility> {
  const visible = new Set((await slugsByVisibility(activeRoot)).visible);
  return (initiative) => initiative === null || visible.has(initiative);
}

/** Every initiative isAgentVisible withholds, for writers that must keep its rows out of agent-read stores. */
export async function ownerOnlySlugs(activeRoot: string): Promise<string[]> {
  return (await slugsByVisibility(activeRoot)).ownerOnly;
}

/**
 * The owner-only slugs a reader must not name to this caller: none for the owner. A deny list, for readers
 * whose keys are not all initiatives (a miner bucket, a doctor path), so only an owner-only name is withheld.
 */
export async function hiddenSlugsForCaller(
  activeRoot: string,
  caller: CommandContext['caller'],
): Promise<ReadonlySet<string>> {
  if (caller === 'owner') return new Set();
  return new Set(await ownerOnlySlugs(activeRoot));
}

const SERVE_ALL: AgentVisibility = () => true;

/**
 * Only a caller the surface names the owner is served every initiative (TP-5453 P6b); an agent,
 * or a context no surface marked, is restricted. A row with no initiative fails closed for a
 * restricted caller, since nothing says whose it is.
 */
export async function callerVisibility(
  activeRoot: string,
  caller: CommandContext['caller'],
): Promise<AgentVisibility> {
  if (caller === 'owner') return SERVE_ALL;
  const visible = await loadAgentVisibility(activeRoot);
  return (initiative) => initiative !== null && visible(initiative);
}

/** Reports what was withheld as a count, never by name. */
export function noteHiddenInitiatives(warnings: string[], hidden: number): void {
  if (hidden === 0) return;
  const noun = hidden === 1 ? 'initiative' : 'initiatives';
  warnings.push(`${hidden} owner-only ${noun} hidden from a non-owner caller`);
}

/** The slugs this caller may list; a non-owner loses the owner-only ones and is told how many. */
async function slugsForCaller(
  activeRoot: string,
  slugs: readonly string[],
  ctx: Pick<CommandContext, 'caller' | 'warnings'>,
): Promise<string[]> {
  const visible = await callerVisibility(activeRoot, ctx.caller);
  const kept = slugs.filter((slug) => visible(slug));
  noteHiddenInitiatives(ctx.warnings, slugs.length - kept.length);
  return kept;
}

/**
 * Every initiative this caller may list. Commands enumerate initiatives only through here, so a
 * new verb inherits the filter; `slug-enumeration.test.ts` holds them to it.
 */
export async function listSlugsForCaller(
  activeRoot: string,
  ctx: Pick<CommandContext, 'caller' | 'warnings'>,
): Promise<string[]> {
  return slugsForCaller(activeRoot, await listInitiativeSlugs(activeRoot), ctx);
}
