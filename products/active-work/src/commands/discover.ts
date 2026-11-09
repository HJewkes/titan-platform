import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { runDiscovery } from '../discover/index.js';

/**
 * `active-work discover` — orchestrates every configured discovery source and emits
 * a flat list of hits. Always non-interactive; Claude is the primary
 * caller, and a human can pipe to a picker.
 */

const ArgsSchema = z.object({
  github_repos: z.array(z.string().min(1)).optional(),
  local_repos: z.array(z.string().min(1)).optional(),
  projects_root: z.string().optional(),
});

const HitSchema = z.object({
  source: z.string(),
  ref: z.string(),
  detail: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  slug_match: z.string().optional(),
  untracked: z.boolean().optional(),
});

const ResultSchema = z.object({
  hits: z.array(HitSchema),
  errors: z.array(z.object({ source: z.string(), error: z.string() })),
});

export default defineCommand({
  name: 'discover',
  description:
    'Scan configured sources (gh PRs, local git, projects root, Claude sessions) and emit unfiltered discovery hits.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      github_repos: {
        long: '--github-repos',
        description: 'owner/repo for gh PR discovery. Repeat the flag for each value',
      },
      local_repos: {
        long: '--local-repos',
        description: 'Repo path for local git discovery. Repeat the flag for each value',
      },
      projects_root: {
        long: '--projects-root',
        description: 'Root directory whose subdirs are scanned as projects',
      },
    },
  },
  async run(args) {
    return runDiscovery({
      github_repos: args.github_repos,
      local_repos: args.local_repos,
      projects_root: args.projects_root,
    });
  },
});
