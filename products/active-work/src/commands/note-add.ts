import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  NOTE_READ_IF_MAX_LENGTH,
  NOTE_TITLE_MAX_LENGTH,
  NoteKindSchema,
  NoteReadIfSchema,
} from '../schemas/note.js';
import { jaccard } from '@titan-design/memory';
import { loadNotesFromDir, writeNoteFile } from '../notes/note-file.js';
import { getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { today } from '../utils/today.js';
import { NotFoundError } from '../errors.js';
import { defineCommand, type CommandContext } from '../registry/index.js';
import { warn } from './_categories.js';

const ArgsSchema = z
  .object({
    slug: z.string().min(1),
    kind: NoteKindSchema,
    title: z
      .string()
      .min(1)
      .max(NOTE_TITLE_MAX_LENGTH, {
        message: `Title must be at most ${NOTE_TITLE_MAX_LENGTH} characters — it is slugified into the filename`,
      }),
    body: z.string().optional(),
    body_file: z.string().optional(),
    tags: z.array(z.string().min(1)).optional(),
    read_if: NoteReadIfSchema.optional(),
    session: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    const hasBody = value.body !== undefined;
    const hasFile = value.body_file !== undefined;
    if (!hasBody && !hasFile) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: 'Exactly one of --body or --body-file is required',
      });
    }
    if (hasBody && hasFile) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: '--body and --body-file are mutually exclusive',
      });
    }
  });

const ResultSchema = z.object({
  path: z.string(),
  filename: z.string(),
  kind: NoteKindSchema,
  title: z.string(),
  read_if: z.string().optional(),
  possible_dup: z.string().optional(),
});

/** An ISO timestamp in the local zone, so its date part agrees with `today()`. */
function localIso(now: Date): string {
  const offsetMin = -now.getTimezoneOffset();
  const local = new Date(now.getTime() + offsetMin * 60_000).toISOString().slice(0, -1);
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${local}${offsetMin < 0 ? '-' : '+'}${hh}:${mm}`;
}

// Same threshold and measure as task add's duplicate flag (_task-related.ts).
const POSSIBLE_DUP_THRESHOLD = 0.9;

/** The filename of the best-matching existing note at or above the threshold. */
async function findPossibleDup(initiativeDir: string, title: string): Promise<string | undefined> {
  const { notes } = await loadNotesFromDir(initiativeDir);
  let best: { filename: string; score: number } | undefined;
  for (const note of notes) {
    const score = jaccard(title, note.frontmatter.title);
    if (score >= POSSIBLE_DUP_THRESHOLD && (best === undefined || score > best.score)) {
      best = { filename: note.filename, score };
    }
  }
  return best?.filename;
}

async function warnPossibleDup(
  ctx: CommandContext,
  initiativeDir: string,
  title: string,
): Promise<string | undefined> {
  const dup = await findPossibleDup(initiativeDir, title);
  if (dup !== undefined) warn(ctx, `possible duplicate of existing note: ${dup}`);
  return dup;
}

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

// A daemon or MCP-over-HTTP caller's environment is the daemon's, so it names no agent.
function buildFrontmatter(args: Args, ctx: CommandContext) {
  const agent = ctx.remote ? undefined : process.env.AGENT_CHAT_NAME || undefined;
  return {
    kind: args.kind,
    title: args.title,
    created: today(),
    created_at: localIso(new Date()),
    ...(args.session !== undefined ? { session: args.session } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(args.tags && args.tags.length > 0 ? { tags: args.tags } : {}),
    ...(args.read_if !== undefined ? { read_if: args.read_if } : {}),
  };
}

export default defineCommand<Args, Result>({
  name: 'note.add',
  description:
    'File a durable note under <slug>/sources/notes/ — a process lesson, gotcha, decision, or FYI that a future session needs but that no task would carry. Actionable work belongs in `task add` instead.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      kind: {
        long: '--kind',
        description: 'process | gotcha | fyi | decision',
        required: true,
      },
      title: {
        long: '--title',
        description: `Short title, at most ${NOTE_TITLE_MAX_LENGTH} chars (slugified into the filename)`,
        required: true,
      },
      body: { long: '--body', description: 'Raw markdown body' },
      body_file: {
        long: '--body-file',
        description: 'Path to a file containing the markdown body',
      },
      tags: { long: '--tags', description: 'Tag for the note. Repeat the flag for each value' },
      read_if: {
        long: '--read-if',
        description: `One-line condition, at most ${NOTE_READ_IF_MAX_LENGTH} chars, for when a session should read this note; shown beside it in the bootstrap`,
      },
      session: { long: '--session', description: 'Session id to stamp on the note' },
    },
    usage:
      'active-work note add <slug> --kind <process|gotcha|fyi|decision> --title <text> (--body <text> | --body-file <path>) [--tags a --tags b] [--read-if <condition>] [--session <id>]',
  },
  async run(args, ctx) {
    const initiativeDir = getInitiativeDir(args.slug);
    try {
      await fs.access(path.join(initiativeDir, 'brief.md'));
    } catch {
      throw new NotFoundError(`Initiative not found: ${args.slug}`);
    }

    const body = args.body ?? (await fs.readFile(args.body_file!, 'utf8'));
    const frontmatter = buildFrontmatter(args, ctx);

    return withFileLock(getLockPath(args.slug), async () => {
      const dup = await warnPossibleDup(ctx, initiativeDir, args.title);
      const written = await writeNoteFile(initiativeDir, frontmatter, body);
      return {
        ...written,
        kind: args.kind,
        title: args.title,
        ...(args.read_if !== undefined ? { read_if: args.read_if } : {}),
        ...(dup !== undefined ? { possible_dup: dup } : {}),
      };
    });
  },
});
