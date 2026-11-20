import { promises as fs } from 'node:fs';
import { IntentLineSchema, parseIntentDigest, type IntentLine, type IntentSection } from '@titan-design/pm';
import { z } from 'zod';
import { defineCommand, type CommandContext } from '../registry/index.js';
import { ValidationError } from '../errors.js';
import { listPlanRecords } from './plan-read.js';
import taskList from './task-list.js';

/*
 * The context a planner starts from: the owner's standing intent (from a digest file), the initiative's success
 * statements, and the tasks that are ready to pick up in one domain.
 */

const ArgsSchema = z.object({
  initiative: z.string().min(1),
  domain: z.string().min(1),
  digest: z.string().min(1),
});

const SeededLineSchema = IntentLineSchema.pick({ id: true, date: true, quote: true, ref: true });

const SEEDED_SECTIONS = [
  ['standing_direction', 'Standing direction'],
  ['reasons', 'Reasons'],
  ['ruled_out', 'Ruled out'],
  ['taste', 'Taste'],
  ['open_questions', 'Open questions'],
] as const satisfies readonly (readonly [string, IntentSection])[];

const ResultSchema = z.object({
  initiative: z.string(),
  domain: z.string(),
  intent: z.object({
    standing_direction: z.array(SeededLineSchema),
    reasons: z.array(SeededLineSchema),
    ruled_out: z.array(SeededLineSchema),
    taste: z.array(SeededLineSchema),
    open_questions: z.array(SeededLineSchema),
  }),
  outcomes: z.array(z.object({ id: z.string(), statement: z.string(), measure: z.string().optional() })),
  tasks: z.array(z.object({ id: z.string(), title: z.string(), priority: z.number(), done_when: z.string() })),
  markdown: z.string(),
});

type Result = z.infer<typeof ResultSchema>;
type Intent = Result['intent'];

async function readDigestLines(path: string): Promise<IntentLine[]> {
  const parsed = parseIntentDigest(await fs.readFile(path, 'utf8'));
  if (parsed.ok) return parsed.lines;
  const problems = parsed.errors.map((error) => `line ${error.line}: ${error.message}`);
  throw new ValidationError(`Invalid intent digest ${path}:\n${problems.join('\n')}`);
}

function seedIntent(lines: readonly IntentLine[]): Intent {
  const live = lines.filter((line) => line.superseded_by === undefined);
  const pick = (section: IntentSection) =>
    live.filter((line) => line.section === section).map(({ id, date, quote, ref }) => ({ id, date, quote, ref }));
  return {
    standing_direction: pick('Standing direction'),
    reasons: pick('Reasons'),
    ruled_out: pick('Ruled out'),
    taste: pick('Taste'),
    open_questions: pick('Open questions'),
  };
}

async function readyTasks(initiative: string, domain: string, ctx: CommandContext): Promise<Result['tasks']> {
  const { tasks } = await taskList.run({ slug: initiative, tag: domain }, { ...ctx, format: 'json' });
  return tasks.flatMap((task) =>
    task.done_when === undefined
      ? []
      : [{ id: task.id, title: task.title, priority: task.priority, done_when: task.done_when }],
  );
}

function renderIntent(intent: Intent): string[] {
  return SEEDED_SECTIONS.flatMap(([key, heading]) => [
    `## ${heading}`,
    ...(intent[key].length === 0 ? ['_none_'] : intent[key].map((l) => `- ${l.id} ${l.date} "${l.quote}" (quote: ${l.ref})`)),
    '',
  ]);
}

function renderMarkdown(result: Omit<Result, 'markdown'>): string {
  const outcomes = result.outcomes.length === 0 ? ['_none_'] : result.outcomes.map((o) => `- ${o.id}: ${o.statement}`);
  const tasks =
    result.tasks.length === 0 ? ['_none_'] : result.tasks.map((t) => `- ${t.id} ${t.title} (done when: ${t.done_when})`);
  return [
    `# Plan seed: ${result.initiative} / ${result.domain}`,
    '',
    ...renderIntent(result.intent),
    '## Success statements',
    ...outcomes,
    '',
    '## Ready tasks',
    ...tasks,
    '',
  ].join('\n');
}

export const planSeed = defineCommand({
  name: 'plan.seed',
  description:
    "Seed a planner: the owner's intent digest, the initiative's success statements and a domain's ready tasks",
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      initiative: { long: '--initiative', description: 'Initiative slug', required: true },
      domain: { long: '--domain', description: 'Domain tag whose open tasks are listed', required: true },
      digest: { long: '--digest', description: 'Path to a titan-intent-digest/v1 file', required: true },
    },
  },
  run: async (args, ctx) => {
    const intent = seedIntent(await readDigestLines(args.digest));
    const outcomeRecords = await listPlanRecords(ctx, 'outcome', args.initiative);
    const outcomes = outcomeRecords.map(({ id, statement, measure }) => ({ id, statement, measure }));
    const tasks = await readyTasks(args.initiative, args.domain, ctx);
    const body = { initiative: args.initiative, domain: args.domain, intent, outcomes, tasks };
    return { ...body, markdown: renderMarkdown(body) };
  },
});
