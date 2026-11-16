import { existsSync } from 'node:fs';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { parseWhyTarget, why } from '../search/why.js';
import { defaultGraphPath } from '../session-index/graph.js';
import { visibilityFor } from '../sessions/visibility.js';
import { UsageError } from '../errors.js';
import { getGitRunner } from '../utils/git-gh.js';

const ArgsSchema = z.object({
  target: z.string().min(1),
  cwd: z.string().min(1).optional(),
});

const StepRow = { step: z.string() };

const CommitSchema = z.object({
  sha: z.string(),
  subject: z.string(),
  lines: z.array(z.string()),
  prNumber: z.number().nullable(),
  prRefs: z.array(z.string()),
  tasks: z.array(z.object({ taskId: z.string(), initiative: z.string().nullable(), ...StepRow })),
  sessions: z.array(z.object({ sessionId: z.string(), title: z.string().nullable(), initiative: z.string().nullable(), ...StepRow })),
  hidden: z.number(),
});

const ResultSchema = z.object({ commits: z.array(CommitSchema) });

export default defineCommand<z.infer<typeof ArgsSchema>, z.infer<typeof ResultSchema>>({
  name: 'why',
  description: 'Map the lines of a file to the commits, PRs, tasks and sessions behind them (git blame at HEAD)',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['target'],
    options: {
      cwd: { long: '--cwd', description: 'Checkout to blame in (default: the current directory)', valueName: 'dir' },
    },
    usage: 'why <path>:<line>[-<end>] [--cwd <dir>]',
  },
  async run(args, ctx) {
    const cwd = args.cwd ?? ctx.cwd;
    if (!cwd) throw new UsageError('why needs --cwd when the caller has no working directory');
    const dbPath = defaultGraphPath();
    if (!existsSync(dbPath)) ctx.warnings.push(`no session graph at ${dbPath}; tasks and sessions are left out`);
    const shown = await visibilityFor(ctx);
    const commits = await why({ target: parseWhyTarget(args.target), cwd, dbPath, activeRoot: ctx.activeRoot, shown, run: getGitRunner() });
    return { commits };
  },
});
