import path from 'node:path';
import { listInitiativeSlugs } from '../sessions/initiatives.js';
import { getActiveRoot } from '../utils/paths.js';
import { lintBrief } from './brief.js';
import { lintEdges, loadTaskIndex, type TaskIndex } from './edges.js';
import { lintHashes } from './hashes.js';
import { lintIntent } from './intent.js';
import { lintOpenLoops } from './open-loops.js';
import { lintSources } from './sources.js';
import { lintTasks } from './task.js';
import { lintZeroLoops } from './zero-loops.js';
import { DEFAULT_LIMITS, type LintFinding, type LintLimits } from './types.js';

export type { LintFinding, LintLimits } from './types.js';
export { DEFAULT_LIMITS } from './types.js';
export { lintBrief } from './brief.js';
export { lintTasks } from './task.js';
export { lintOpenLoops } from './open-loops.js';
export { lintZeroLoops } from './zero-loops.js';
export { lintSources } from './sources.js';
export { lintHashes } from './hashes.js';
interface LintOptions {
  activeRoot?: string;
  limits?: LintLimits;
  /** Injected for determinism; defaults to `new Date()`. */
  now?: Date;
  /** Cross-initiative task index; lintAll builds it once, lintSlug builds it when absent. */
  taskIndex?: TaskIndex;
  /** Injected so a test can count index loads; defaults to the real loader. */
  loadTaskIndex?: typeof loadTaskIndex;
}

/**
 * Run every lint against a single initiative and concatenate the findings.
 *
 * Per-lint errors propagate; missing artifacts (handled inside each lint)
 * simply yield no findings.
 */
export async function lintSlug(slug: string, options: LintOptions = {}): Promise<LintFinding[]> {
  const activeRoot = options.activeRoot ?? getActiveRoot();
  const limits = options.limits ?? DEFAULT_LIMITS;
  const now = options.now ?? new Date();
  const initiativeDir = path.join(activeRoot, slug);
  const load = options.loadTaskIndex ?? loadTaskIndex;
  const taskIndex =
    options.taskIndex ?? (await load(activeRoot, await listInitiativeSlugs(activeRoot)));
  const [brief, tasks, openLoops, zeroLoops, sources, hashes, intent] = await Promise.all([
    lintBrief(slug, initiativeDir, limits),
    lintTasks(slug, initiativeDir, limits),
    lintOpenLoops(slug, initiativeDir, limits, now),
    lintZeroLoops(slug, initiativeDir),
    lintSources(slug, initiativeDir),
    lintHashes(slug, initiativeDir),
    lintIntent(slug, initiativeDir),
  ]);
  const edges = lintEdges(slug, taskIndex);
  return [...brief, ...tasks, ...edges, ...openLoops, ...zeroLoops, ...sources, ...hashes, ...intent];
}

/**
 * Lint every initiative under `activeRoot` and return the aggregated
 * findings ordered by slug.
 */
export async function lintAll(options: LintOptions = {}): Promise<LintFinding[]> {
  const activeRoot = options.activeRoot ?? getActiveRoot();
  const slugs = await listInitiativeSlugs(activeRoot);
  const taskIndex = await (options.loadTaskIndex ?? loadTaskIndex)(activeRoot, slugs);
  const findings: LintFinding[] = [];
  for (const slug of slugs) {
    const slugFindings = await lintSlug(slug, {
      activeRoot,
      taskIndex,
      limits: options.limits,
      now: options.now,
    });
    findings.push(...slugFindings);
  }
  return findings;
}
