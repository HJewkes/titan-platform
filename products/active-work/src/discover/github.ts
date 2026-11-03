import { z } from 'zod';
import type { DiscoveryHit, DiscoverySourceError } from './types.js';
import { runCommand, type RunCommand } from './run-command.js';

/**
 * Discover open PRs authored by the current user, per repo.
 *
 * Shells out to `gh pr list --author @me --state open` and converts each
 * PR to a `DiscoveryHit`. Failures (gh missing, auth, network) are
 * captured per-repo and never thrown.
 */

const GhPullRequestSchema = z.looseObject({
  number: z.number(),
  title: z.string(),
  isDraft: z.boolean(),
  headRefName: z.string(),
  updatedAt: z.string(),
});

type GhPullRequest = z.infer<typeof GhPullRequestSchema>;

export interface DiscoverGitHubResult {
  hits: DiscoveryHit[];
  errors: DiscoverySourceError[];
}

export async function discoverGitHub(
  repos: string[],
  run: RunCommand = runCommand,
): Promise<DiscoverGitHubResult> {
  const hits: DiscoveryHit[] = [];
  const errors: DiscoverySourceError[] = [];

  for (const repo of repos) {
    const sourceId = `gh:${repo}`;
    try {
      const result = await run('gh', [
        'pr',
        'list',
        '--author',
        '@me',
        '--state',
        'open',
        '--limit',
        '100',
        '--repo',
        repo,
        '--json',
        'number,title,isDraft,headRefName,updatedAt',
      ]);
      if (result.code !== 0) {
        errors.push({
          source: sourceId,
          error: result.stderr.trim() || `gh exited with code ${result.code}`,
        });
        continue;
      }
      const { prs, skipped } = parsePullRequests(result.stdout);
      hits.push(...prs.map((pr) => toHit(sourceId, repo, pr)));
      if (skipped > 0) {
        errors.push({ source: sourceId, error: `skipped ${skipped} malformed PR entries` });
      }
    } catch (err) {
      errors.push({
        source: sourceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { hits, errors };
}

/** Throws when stdout is not a JSON array; a bad element is counted, not thrown. */
function parsePullRequests(stdout: string): { prs: GhPullRequest[]; skipped: number } {
  const parsed = z.array(z.unknown()).parse(JSON.parse(stdout));
  const prs = parsed.flatMap((element) => {
    const pr = GhPullRequestSchema.safeParse(element);
    return pr.success ? [pr.data] : [];
  });
  return { prs, skipped: parsed.length - prs.length };
}

function toHit(source: string, repo: string, pr: GhPullRequest): DiscoveryHit {
  return {
    source,
    ref: pr.headRefName,
    detail: `${pr.isDraft ? '[draft] ' : ''}#${pr.number} ${pr.title}`,
    metadata: {
      repo,
      number: pr.number,
      title: pr.title,
      isDraft: pr.isDraft,
      headRefName: pr.headRefName,
      updatedAt: pr.updatedAt,
    },
  };
}
