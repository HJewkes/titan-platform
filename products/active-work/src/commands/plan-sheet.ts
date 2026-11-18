import { scorecardStorePath } from '@titan-design/app-paths';
import { BetSchema } from '@titan-design/pm';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { buildWeeklySheet } from '../plan/sheet.js';
import { readScorecardRows, scorecardReadings } from '../plan/sheet-scorecard.js';
import {
  latestSheetWeek,
  readSheet,
  readSheetDecisions,
  SheetDecisionsSchema,
  writeSheet,
  writeSheetDecisions,
  type SheetDecisions,
} from '../plan/sheet-store.js';
import { assertInitiativeExists, loadPlanRecords, withPlanLock } from '../plan/store.js';
import { today } from '../utils/today.js';

/*
 * The weekly sheet (TP-5453 P16). Reading a sheet never decides anything: its defaults become decisions only through
 * `plan.sheet.apply-defaults`, and only once the sheet's deadline has passed with no answer recorded.
 */

const text = z.string().min(1);
const week = BetSchema.shape.week;

const flag = z.object({ bet: z.string(), problem: z.string() });
const sheetDefault = z.object({ bet: z.string(), action: z.enum(['select', 'hold', 'stop']) });
const SheetResultSchema = z.object({
  initiative: z.string(),
  week: z.string(),
  next_week: z.string(),
  deadline: z.string(),
  defaults: z.array(sheetDefault),
  flags: z.array(flag),
  markdown: z.string(),
});

/** Once a sheet's decisions are recorded, neither a regenerated sheet nor a second answer may replace what they answered. */
async function refuseAnswered(activeRoot: string, initiative: string, sheetWeek: string): Promise<void> {
  if ((await readSheetDecisions(activeRoot, initiative, sheetWeek)) !== null) {
    throw new ValidationError(`The ${initiative} ${sheetWeek} sheet already has decisions recorded`);
  }
}

const GenerateArgsSchema = z.object({ initiative: text, week, scorecard: text.optional() });

export const planSheetGenerate = defineCommand({
  name: 'plan.sheet.generate',
  description: "Write an initiative's weekly sheet to plan/sheets/<week>.md; bet lines citing no intent line are flagged",
  args: GenerateArgsSchema,
  result: SheetResultSchema.extend({ path: z.string() }),
  cli: {
    positional: ['initiative'],
    options: {
      week: { long: '--week', description: 'ISO week the sheet reviews, e.g. 2026-W47', required: true },
      scorecard: { long: '--scorecard', description: 'Ticket scorecard store (default: the scorecard store path)' },
    },
  },
  run: async (args, ctx) => {
    await assertInitiativeExists(ctx.activeRoot, args.initiative);
    return withPlanLock(ctx.activeRoot, args.initiative, async () => {
      await refuseAnswered(ctx.activeRoot, args.initiative, args.week);
      const rows = readScorecardRows(args.scorecard ?? scorecardStorePath());
      const sheet = buildWeeklySheet({
        initiative: args.initiative,
        week: args.week,
        outcomes: await loadPlanRecords(ctx.activeRoot, args.initiative, 'outcome'),
        bets: await loadPlanRecords(ctx.activeRoot, args.initiative, 'bet'),
        scorecard: scorecardReadings(rows, args.initiative, args.week),
      });
      const path = await writeSheet(ctx.activeRoot, args.initiative, args.week, sheet.markdown);
      return { ...sheet, path };
    });
  },
});

const ShowArgsSchema = z.object({ initiative: text, week: week.optional() });

export const planSheetShow = defineCommand({
  name: 'plan.sheet.show',
  description: "Show an initiative's weekly sheet (default: the newest) and any decisions recorded for it",
  args: ShowArgsSchema,
  result: SheetResultSchema.extend({ decisions: SheetDecisionsSchema.nullable() }),
  cli: {
    positional: ['initiative'],
    options: { week: { long: '--week', description: 'ISO week of the sheet (default: the newest sheet)' } },
  },
  run: async (args, ctx) => {
    await assertInitiativeExists(ctx.activeRoot, args.initiative);
    const sheetWeek = args.week ?? (await latestSheetWeek(ctx.activeRoot, args.initiative));
    const sheet = sheetWeek === null ? null : await readSheet(ctx.activeRoot, args.initiative, sheetWeek);
    if (sheetWeek === null || sheet === null) throw new NotFoundError(`No weekly sheet for ${args.initiative}${args.week ? ` ${args.week}` : ''}`);
    const decisions = await readSheetDecisions(ctx.activeRoot, args.initiative, sheetWeek);
    return { ...sheet.front, markdown: sheet.markdown, decisions };
  },
});

// No date argument: the deadline is judged against the host clock, so no caller can move an ignored sheet's deadline.
const ApplyArgsSchema = z.object({ initiative: text, week });

export const planSheetApplyDefaults = defineCommand({
  name: 'plan.sheet.apply-defaults',
  description: 'Record a weekly sheet\'s defaults as its decisions once its deadline has passed with no answer',
  args: ApplyArgsSchema,
  result: SheetDecisionsSchema,
  cli: {
    positional: ['initiative'],
    options: {
      week: { long: '--week', description: 'ISO week of the sheet', required: true },
    },
  },
  run: async (args, ctx) =>
    withPlanLock(ctx.activeRoot, args.initiative, async () => {
      const sheet = await readSheet(ctx.activeRoot, args.initiative, args.week);
      if (sheet === null) throw new NotFoundError(`No weekly sheet for ${args.initiative} ${args.week}`);
      await refuseAnswered(ctx.activeRoot, args.initiative, args.week);
      const day = today();
      if (day <= sheet.front.deadline) throw new ValidationError(`The sheet is open until ${sheet.front.deadline}; defaults apply after it`);
      const decisions: SheetDecisions = { initiative: args.initiative, week: args.week, decided_by: 'default', decided_on: day, decisions: sheet.front.defaults };
      await writeSheetDecisions(ctx.activeRoot, decisions);
      return decisions;
    }),
});
