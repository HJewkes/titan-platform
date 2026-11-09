import type { Artifacts, BranchEntry, WorktreeEntry } from '../schemas/artifacts.js';
import { LIVE_RENDER_LIMIT } from './live-status.js';
import type { LiveBranchStatus, LiveStatusFetcher } from './prompt.js';

function renderStaticBranchLine(branch: BranchEntry): string {
  const head = `- ${branch.name} (${branch.repo})`;
  return branch.note ? `${head} — ${branch.note}` : head;
}

/**
 * The PR title and url were fetched and then dropped, which made the branch
 * block un-actionable: `PR #12 OPEN` tells a session nothing about what the PR
 * is for and gives it nowhere to look. The same goes for `last_commit_iso` —
 * without it, a branch that has been idle for two months reads identically to
 * one touched an hour ago. Both are carried on the line now; the url goes on a
 * continuation line so the primary line stays scannable.
 */
function renderLiveBranchLine(status: LiveBranchStatus): string {
  const parts: string[] = [`- ${status.name} (${status.repo})`];
  if (!status.present) {
    parts.push('[missing locally]');
  } else if (status.ahead !== null && status.behind !== null) {
    parts.push(`+${status.ahead}/-${status.behind}`);
  }
  if (status.last_commit_iso) {
    parts.push(`last commit ${status.last_commit_iso.slice(0, 10)}`);
  }
  if (status.pr) {
    const checks = status.pr.checks ? ` ${status.pr.checks}` : '';
    parts.push(`PR #${status.pr.number} ${status.pr.state}${checks}`);
  }
  let line = parts.join(' ');
  if (status.note) line += ` — ${status.note}`;
  if (status.pr) {
    line += `\n  PR: ${status.pr.title} — ${status.pr.url}`;
  }
  return line;
}

const WORKTREE_RENDER_LIMIT = 8;

function renderWorktreeLine(entry: WorktreeEntry): string {
  const parts: string[] = [`- ${entry.name}${entry.default ? ' (default)' : ''}: ${entry.path}`];
  if (entry.branch) parts.push(`[${entry.branch}]`);
  if (entry.pr) parts.push(`PR #${entry.pr}`);
  const trailer = entry.holding ?? entry.note;
  return trailer ? `${parts.join(' ')} — ${trailer}` : parts.join(' ');
}

/**
 * Only *registered* worktrees get a line.
 *
 * `worktrees[]` mixes two populations (see `src/schemas/artifacts.ts`): entries
 * the operator named and registered — these resolve `aw <slug>`'s cwd — and
 * entries `wrap` merely swept out of git. Listing every swept tree would bury
 * the two the session actually launches into under a pile of unrelated repos
 * the operator never asked about. The observed ones still get counted, so their
 * existence is visible without their noise, and the count names the command
 * that shows them.
 */
function renderWorktrees(artifacts: Artifacts, slug: string): string | null {
  const registered = artifacts.worktrees.filter((w) => w.name !== undefined);
  const observed = artifacts.worktrees.length - registered.length;
  if (registered.length === 0 && observed === 0) return null;

  const lines: string[] = [];
  const shown = registered.slice(0, WORKTREE_RENDER_LIMIT);
  if (shown.length > 0) {
    lines.push(...shown.map(renderWorktreeLine));
  } else {
    lines.push('_None registered._');
  }
  const overflow = registered.length - shown.length;
  if (overflow > 0) {
    lines.push(`(+${overflow} more registered — \`active-work artifact list ${slug}\`)`);
  }
  if (observed > 0) {
    const noun = observed === 1 ? 'worktree' : 'worktrees';
    lines.push(
      `(+${observed} observed ${noun} swept from git, not registered — \`active-work artifact list ${slug}\`)`,
    );
  }
  return `Worktrees (registered):\n${lines.join('\n')}`;
}

function renderStashes(artifacts: Artifacts): string | null {
  if (artifacts.stashes.length === 0) return null;
  return artifacts.stashes
    .map((s) => `- ${s.repo}: ${s.label}${s.sha ? ` (${s.sha.slice(0, 12)})` : ''}`)
    .join('\n');
}

function renderStaticArtifacts(artifacts: Artifacts, slug: string): string | null {
  const sections: string[] = [];
  if (artifacts.branches.length > 0) {
    const branchLines = artifacts.branches.map(renderStaticBranchLine).join('\n');
    sections.push(`Branches:\n${branchLines}`);
  }
  const worktreeBody = renderWorktrees(artifacts, slug);
  if (worktreeBody) sections.push(worktreeBody);
  const stashBody = renderStashes(artifacts);
  if (stashBody) sections.push(`Stashes:\n${stashBody}`);
  return sections.length > 0 ? sections.join('\n\n') : null;
}

function renderLiveArtifacts(
  artifacts: Artifacts,
  statuses: LiveBranchStatus[],
  slug: string,
): string | null {
  const sections: string[] = [];
  if (statuses.length > 0) {
    const shown = statuses.slice(0, LIVE_RENDER_LIMIT);
    const lines = shown.map(renderLiveBranchLine).join('\n');
    const overflow = statuses.length - shown.length;
    const suffix = overflow > 0 ? `\n(+${overflow} more)` : '';
    sections.push(`Branches (live):\n${lines}${suffix}`);
  } else if (artifacts.branches.length > 0) {
    const branchLines = artifacts.branches.map(renderStaticBranchLine).join('\n');
    sections.push(`Branches:\n${branchLines}`);
  }
  const worktreeBody = renderWorktrees(artifacts, slug);
  if (worktreeBody) sections.push(worktreeBody);
  const stashBody = renderStashes(artifacts);
  if (stashBody) sections.push(`Stashes:\n${stashBody}`);
  return sections.length > 0 ? sections.join('\n\n') : null;
}
export async function renderArtifactsBody(args: {
  artifacts: Artifacts;
  slug: string;
  includeLiveStatus: boolean;
  fetcher: LiveStatusFetcher;
}): Promise<string | null> {
  const { artifacts, slug, includeLiveStatus, fetcher } = args;
  if (!includeLiveStatus || artifacts.branches.length === 0) {
    return renderStaticArtifacts(artifacts, slug);
  }
  try {
    const statuses = await fetcher(artifacts.branches);
    return renderLiveArtifacts(artifacts, statuses, slug);
  } catch {
    // Live fetch failed entirely — degrade to static rendering.
    return renderStaticArtifacts(artifacts, slug);
  }
}
