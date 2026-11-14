import { promises as fs } from 'node:fs';
import path from 'node:path';
import { agentAccess, isAgentVisible, type AgentAccess } from '@titan-design/pm';
import { loadHumanOnlyInitiatives } from './charter.js';
import { UsageError } from '../errors.js';
import type { CommandContext } from '../registry/types.js';
import { parseFrontmatter } from '../utils/gray-matter-io.js';
import { listInitiativeSlugs } from './initiatives.js';

/**
 * The only module that decides which initiatives an agent may read (TP-5556). It joins the
 * brief and the charter through `agentAccess` and hands readers a `Shown`, which only this
 * module can build, so no reader can widen or rebuild the verdict for itself.
 * `visibility-boundary.test.ts` holds every other file to that.
 */

const SHOWN_BRAND: unique symbol = Symbol('Shown');

/** Whether a row tied to this initiative (or to none, `null`) may be served to the caller. */
export type Shown = ((initiative: string | null) => boolean) & { readonly [SHOWN_BRAND]: true };

function brand(test: (initiative: string | null) => boolean): Shown {
  return Object.assign(test, { [SHOWN_BRAND]: true as const });
}

const SERVE_ALL = brand(() => true);
const SERVE_NONE = brand(() => false);

type VisibilityContext = Pick<CommandContext, 'activeRoot' | 'caller' | 'warnings'>;
type HumanOnly = ReadonlySet<string> | 'unknown';

interface Verdict {
  slug: string;
  brief: unknown;
  access: AgentAccess;
}

/** The brief's front matter, or null when the file is missing or will not parse. */
async function readBriefFrontmatter(activeRoot: string, slug: string): Promise<unknown> {
  try {
    return parseFrontmatter(await fs.readFile(path.join(activeRoot, slug, 'brief.md'), 'utf8')).data;
  } catch {
    return null;
  }
}

async function readHumanOnly(activeRoot: string): Promise<HumanOnly> {
  try {
    return await loadHumanOnlyInitiatives(activeRoot);
  } catch {
    return 'unknown';
  }
}

async function verdictsFor(activeRoot: string, slugs: readonly string[]): Promise<Verdict[]> {
  const humanOnly = await readHumanOnly(activeRoot);
  return Promise.all(
    slugs.map(async (slug) => {
      const brief = await readBriefFrontmatter(activeRoot, slug);
      const listed = humanOnly === 'unknown' ? 'unknown' : humanOnly.has(slug);
      return { slug, brief, access: agentAccess({ slug, brief, humanOnly: listed }) };
    }),
  );
}

/** Null when the root cannot be listed: then nothing is known to be shown. */
async function liveVerdicts(activeRoot: string): Promise<Verdict[] | null> {
  try {
    return await verdictsFor(activeRoot, await listInitiativeSlugs(activeRoot));
  } catch {
    return null;
  }
}

/** Reports what was withheld as a count, never by name. */
function noteHiddenInitiatives(warnings: string[], hidden: number): void {
  if (hidden === 0) return;
  const noun = hidden === 1 ? 'initiative' : 'initiatives';
  const warning = `${hidden} owner-only ${noun} hidden from a non-owner caller`;
  if (!warnings.includes(warning)) warnings.push(warning);
}

/**
 * What this caller may be served. The owner gets everything. Any other caller, an unmarked one
 * included, gets an allow list of initiatives on disk now whose verdict is `shown`, so a null
 * initiative, a name from history and every name under an unreadable root are withheld.
 */
export async function visibilityFor(ctx: VisibilityContext): Promise<Shown> {
  if (ctx.caller === 'owner') return SERVE_ALL;
  const verdicts = await liveVerdicts(ctx.activeRoot);
  if (verdicts === null) {
    ctx.warnings.push('the active root could not be read; every initiative is hidden from a non-owner caller');
    return SERVE_NONE;
  }
  const shown = new Set(verdicts.filter((verdict) => verdict.access === 'shown').map((verdict) => verdict.slug));
  noteHiddenInitiatives(ctx.warnings, verdicts.length - shown.size);
  return brand((initiative) => initiative !== null && shown.has(initiative));
}

/**
 * Every initiative this caller may list. Commands enumerate initiatives only through here, so a
 * new verb inherits the filter; `visibility-boundary.test.ts` holds them to it.
 */
export async function listSlugsForCaller(
  activeRoot: string,
  ctx: Pick<CommandContext, 'caller' | 'warnings'>,
): Promise<string[]> {
  return listShownSlugs(activeRoot, await visibilityFor({ ...ctx, activeRoot }));
}

/** The initiatives on disk that a verdict already loaded serves, for readers handed a `Shown`. */
export async function listShownSlugs(activeRoot: string, shown: Shown): Promise<string[]> {
  return (await listInitiativeSlugs(activeRoot)).filter((slug) => shown(slug));
}

/** Refuses every caller but the owner, an unmarked one included. */
export function requireOwner(ctx: Pick<CommandContext, 'caller'>, verb: string): void {
  if (ctx.caller !== 'owner') throw new UsageError(`${verb} is for the owner only; run it from the owner's own terminal`);
}

/** Every initiative withheld from agents, for writers that must keep its rows out of agent-read stores. */
export async function withheldSlugs(activeRoot: string): Promise<string[]> {
  const verdicts = (await liveVerdicts(activeRoot)) ?? [];
  return verdicts.filter((verdict) => verdict.access === 'withheld').map((verdict) => verdict.slug);
}

/**
 * The brief alone, for the workspace-index writer and the field back-fill. It withholds no more
 * than `visibilityFor` does, and everything that reads the index filters again through `Shown`,
 * so the charter's narrowing still reaches agents.
 */
export function briefAllowsAgents(slug: string, brief: unknown): boolean {
  return isAgentVisible({ slug, brief });
}

export async function initiativeIsAgentVisible(activeRoot: string, slug: string): Promise<boolean> {
  return briefAllowsAgents(slug, await readBriefFrontmatter(activeRoot, slug));
}

interface WireVisibility {
  /** The brief alone, as before TP-5556; kept for older readers. */
  agent_visible: boolean;
  /** The full verdict: true unless the brief and a readable charter both allow agents. */
  withheld_from_agents: boolean;
}

/** The per-initiative flags wire emitters put on their rows, whoever the caller is. */
export async function wireVisibility(activeRoot: string, slugs: readonly string[]): Promise<Map<string, WireVisibility>> {
  const verdicts = await verdictsFor(activeRoot, slugs);
  return new Map(
    verdicts.map(({ slug, brief, access }) => [
      slug,
      { agent_visible: briefAllowsAgents(slug, brief), withheld_from_agents: access !== 'shown' },
    ]),
  );
}
