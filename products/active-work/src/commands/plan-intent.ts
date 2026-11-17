import { INTENT_DIGEST_SCHEMA, INTENT_SECTIONS, IntentLineSchema, parseIntentDigest, type IntentLine } from '@titan-design/pm';
import { z } from 'zod';
import { defineCommand, type CommandContext } from '../registry/index.js';
import { NotFoundError, UsageError, ValidationError } from '../errors.js';
import { atomicWrite } from '../utils/fs-atomic.js';
import {
  appendOwnerMessages,
  legacyOwnerMessagesPath,
  ownerMessagesPath,
  readOwnerMessageFile,
  readOwnerMessages,
} from '../plan/owner-messages.js';
import { assertInitiativeExists, loadLaneIntentLines, loadPlanRecords, writeLaneIntent, nextPlanId, withPlanLock, writePlanRecord } from '../plan/store.js';

/*
 * Intent lines (TP-5453 P9): the owner's words, dated and quoted, that bets and freezes cite as `<initiative>/I<n>`.
 * A line names the message it quotes, so `--message` takes the date and reference from the owner-message extract.
 * `--lane` numbers lines `<lane>/I<n>` inside one initiative; without it the lane is the initiative itself.
 */

const text = z.string().min(1);

const AddArgsSchema = z.object({
  initiative: text,
  section: text,
  quote: z.string().optional(),
  date: text.optional(),
  ref: text.optional(),
  message: text.optional(),
  lane: text.optional(),
});

type AddArgs = z.infer<typeof AddArgsSchema>;

type Quoted = Pick<Partial<IntentLine>, 'date' | 'quote' | 'ref'>;

async function quotedFromMessage(ctx: CommandContext, args: AddArgs, messageId: string): Promise<Quoted> {
  if (args.date !== undefined || args.ref !== undefined) throw new UsageError('--message sets the date and ref; drop --date and --ref');
  const message = (await readOwnerMessages(ctx.activeRoot)).find((row) => row.id === messageId);
  if (message === undefined) throw new NotFoundError(`Owner message not found: ${messageId}`);
  const quote = args.quote ?? message.text;
  if (!message.text.includes(quote)) throw new ValidationError(`The quote is not in owner message ${messageId}`);
  return { date: message.ts.slice(0, 10), quote, ref: `msg:${messageId}` };
}

const laneOf = (args: { initiative: string; lane?: string | undefined }): string => args.lane ?? args.initiative;
const isOwnLane = (args: { initiative: string; lane?: string | undefined }): boolean => laneOf(args) === args.initiative;

function validLine(candidate: object): IntentLine {
  const parsed = IntentLineSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  throw new ValidationError(`Invalid intent line:\n${problems.join('\n')}`);
}

export const planIntentAdd = defineCommand({
  name: 'plan.intent.add',
  description: "Add a dated, quoted line of the owner's intent; refused without a quote and a date",
  args: AddArgsSchema,
  result: IntentLineSchema,
  cli: {
    positional: ['initiative'],
    options: {
      section: { long: '--section', description: `One of: ${INTENT_SECTIONS.join(', ')}`, required: true },
      message: { long: '--message', description: 'Owner message id; sets the date and the msg:<id> ref from the extract' },
      quote: { long: '--quote', description: "The owner's exact words, on one line (default with --message: the whole message)" },
      date: { long: '--date', description: 'Date of the words, YYYY-MM-DD (without --message)' },
      ref: { long: '--ref', description: 'Reference to the exact quote, e.g. msg:abc123 (without --message)' },
      lane: { long: '--lane', description: 'Number the line <lane>/I<n> and file it under this lane of the initiative (default: the initiative)' },
    },
  },
  run: async (args, ctx) => {
    const quoted = args.message === undefined ? args : await quotedFromMessage(ctx, args, args.message);
    const lane = laneOf(args);
    return withPlanLock(ctx.activeRoot, args.initiative, async () => {
      const existing = isOwnLane(args)
        ? await loadPlanRecords(ctx.activeRoot, args.initiative, 'intent')
        : await loadLaneIntentLines(ctx.activeRoot, args.initiative, lane);
      const id = nextPlanId(lane, 'I', existing);
      const line = validLine({ id, section: args.section, date: quoted.date, quote: quoted.quote, ref: quoted.ref });
      if (isOwnLane(args)) return writePlanRecord(ctx.activeRoot, 'intent', line);
      return writeLaneIntent(ctx.activeRoot, args.initiative, lane, line);
    });
  },
});

const intentNumber = (id: string): number => Number(id.split('/I')[1]);

function renderBullet(line: IntentLine): string {
  const superseded = line.superseded_by === undefined ? '' : ` superseded-by: I${intentNumber(line.superseded_by)}`;
  return `- I${intentNumber(line.id)} ${line.date} "${line.quote}" (quote: ${line.ref})${superseded}`;
}

function renderDigest(lane: string, initiative: string, lines: readonly IntentLine[]): string {
  const ordered = [...lines].sort((a, b) => intentNumber(a.id) - intentNumber(b.id));
  const head = ['---', `schema: ${INTENT_DIGEST_SCHEMA}`, `slug: ${lane}`, `initiative: ${initiative}`, 'built_from: plan/intent records', '---'];
  const body = INTENT_SECTIONS.flatMap((section) => [
    `## ${section}`,
    ...ordered.filter((line) => line.section === section).map(renderBullet),
  ]);
  return [...head, ...body, ''].join('\n');
}

const DigestArgsSchema = z.object({ initiative: text, out: text.optional(), lane: text.optional() });

export const planIntentDigest = defineCommand({
  name: 'plan.intent.digest',
  description: "Render an initiative's intent lines as a titan-intent-digest/v1 file, each line citing its message",
  args: DigestArgsSchema,
  result: z.object({ initiative: z.string(), lines: z.array(IntentLineSchema), markdown: z.string() }),
  cli: {
    positional: ['initiative'],
    options: {
      out: { long: '--out', description: 'Write the digest to this path as well' },
      lane: { long: '--lane', description: 'Render this lane of the initiative (default: the initiative)' },
    },
  },
  run: async (args, ctx) => {
    await assertInitiativeExists(ctx.activeRoot, args.initiative);
    const lines = isOwnLane(args)
      ? await loadPlanRecords(ctx.activeRoot, args.initiative, 'intent')
      : await loadLaneIntentLines(ctx.activeRoot, args.initiative, laneOf(args));
    const markdown = renderDigest(laneOf(args), args.initiative, lines);
    const parsed = parseIntentDigest(markdown);
    if (!parsed.ok) throw new ValidationError(parsed.errors.map((error) => `line ${error.line}: ${error.message}`).join('\n'));
    if (args.out !== undefined) await atomicWrite(args.out, markdown);
    return { initiative: args.initiative, lines: parsed.lines, markdown };
  },
});

const ImportArgsSchema = z.object({ from: text.optional() });

export const planIntentImportMessages = defineCommand({
  name: 'plan.intent.import-messages',
  description: 'Append an owner-message extract to factory/plan/owner-messages.jsonl, skipping message ids already there',
  args: ImportArgsSchema,
  result: z.object({ path: z.string(), added: z.number(), total: z.number() }),
  cli: {
    options: { from: { long: '--from', description: 'Extract to import (default: the old sources/owner-intent extract)' } },
  },
  run: async (args, ctx) => {
    const rows = await readOwnerMessageFile(args.from ?? legacyOwnerMessagesPath(ctx.activeRoot));
    const { added, total } = await appendOwnerMessages(ctx.activeRoot, rows);
    return { path: ownerMessagesPath(ctx.activeRoot), added, total };
  },
});
