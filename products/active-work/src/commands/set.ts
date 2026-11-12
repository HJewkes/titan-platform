import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BriefFrontmatterSchema } from '../schemas/brief.js';
import { getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readRawFrontmatter, writeFrontmatter } from '../utils/gray-matter-io.js';
import { today } from '../utils/today.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { defineCommand, type CommandContext } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  field: z.string().min(1),
  value: z.unknown(),
});

const ResultSchema = z.object({
  slug: z.string(),
  field: z.string(),
  value: z.unknown(),
});

function setPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.').filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new ValidationError('Field path must not be empty');
  }
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cursor[key];
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      const fresh: Record<string, unknown> = {};
      cursor[key] = fresh;
      cursor = fresh;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  cursor[parts[parts.length - 1]!] = value;
}

/**
 * Who agents may read is the owner's call (TP-5453 P6): an agent caller cannot set
 * `visibility`, so it cannot widen its own read access through this verb.
 */
function assertOwnerMayWrite(field: string, caller: CommandContext['caller']): void {
  const top = field.split('.').find((part) => part.length > 0);
  if (top === 'visibility' && caller === 'agent') {
    throw new ValidationError(
      'visibility is set by the owner from their own terminal, not by an agent',
    );
  }
}

export default defineCommand({
  name: 'set',
  description: 'Set a single field on an initiative brief.md frontmatter.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug', 'field', 'value'],
    usage: 'active-work set <slug> <field> <value>',
  },
  async run(args, ctx) {
    assertOwnerMayWrite(args.field, ctx.caller);
    const dir = path.join(ctx.activeRoot, args.slug);
    const briefPath = path.join(dir, 'brief.md');
    try {
      await fs.access(briefPath);
    } catch {
      throw new NotFoundError(`Initiative not found: ${args.slug}`);
    }

    await withFileLock(getLockPath(args.slug), async () => {
      const { frontmatter, body } = await readRawFrontmatter(briefPath);
      setPath(frontmatter, args.field, args.value);
      frontmatter.updated = today();
      try {
        await writeFrontmatter(briefPath, frontmatter, body, BriefFrontmatterSchema);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new ValidationError(
          `Cannot set ${args.field}=${JSON.stringify(args.value)}: ${reason}`,
        );
      }
    });

    return { slug: args.slug, field: args.field, value: args.value };
  },
});
