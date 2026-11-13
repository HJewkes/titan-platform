import { BetSchema, type Bet } from '@titan-design/pm';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { ValidationError } from '../errors.js';
import { loadPlanRecords, nextPlanId, planRecordExists, withPlanLock, writePlanRecord } from '../plan/store.js';
import { listPlanRecords } from './plan-read.js';

/*
 * Bets are proposed here and nowhere selected: selection is an owner action that arrives as a console owner
 * operation (TP-5453 P3b), so no CLI or RPC path moves a bet out of `proposed`.
 */

const { shape } = BetSchema;
const { shape: prediction } = shape.prediction;

const AddArgsSchema = z.object({
  initiative: z.string().min(1),
  week: shape.week,
  outcome: shape.outcome,
  order: shape.order.optional(),
  task: z.array(z.string().min(1)).optional(),
  selector: shape.selector,
  metric: prediction.metric,
  direction: prediction.direction,
  baseline: prediction.baseline,
  expected: prediction.expected,
  read_by: prediction.read_by,
});

type AddArgs = z.infer<typeof AddArgsSchema>;

function proposedBet(args: AddArgs, id: string, order: number): Bet {
  const { metric, direction, baseline, expected, read_by } = args;
  return {
    id,
    initiative: args.initiative,
    week: args.week,
    outcome: args.outcome,
    order,
    tasks: args.task && [...new Set(args.task)],
    selector: args.selector,
    prediction: { metric, direction, baseline, expected, read_by },
    state: 'proposed',
  };
}

function nextOrder(bets: readonly Bet[], week: string): number {
  return Math.max(0, ...bets.filter((bet) => bet.week === week).map((bet) => bet.order)) + 1;
}

export const planBetAdd = defineCommand({
  name: 'plan.bet.add',
  description: 'Propose a bet for an ISO week; it is written as proposed, and only the owner selects it',
  args: AddArgsSchema,
  result: BetSchema,
  cli: {
    positional: ['initiative'],
    options: {
      week: { long: '--week', description: 'ISO week, e.g. 2026-W47', required: true },
      outcome: { long: '--outcome', description: 'Outcome id the bet serves (alpha/faster-landing)', required: true },
      order: { long: '--order', description: "Rank within the week (default: after the week's last bet)" },
      task: { long: '--task', description: 'Task key <initiative>/<ID>. Repeat the flag for each value' },
      selector: { long: '--selector', description: 'Selector naming the tasks, instead of --task' },
      metric: { long: '--metric', description: 'Metric the bet should move', required: true },
      direction: { long: '--direction', description: 'increase|decrease', required: true },
      baseline: { long: '--baseline', description: 'Metric value now', required: true },
      expected: { long: '--expected', description: 'Metric value expected by --read-by', required: true },
      read_by: { long: '--read-by', description: 'Date the prediction is read, YYYY-MM-DD', required: true },
    },
  },
  run: async (args, ctx) =>
    withPlanLock(ctx.activeRoot, args.initiative, async () => {
      if (!(await planRecordExists(ctx.activeRoot, 'outcome', args.outcome))) {
        throw new ValidationError(`Unknown outcome id: ${args.outcome}`);
      }
      const bets = await loadPlanRecords(ctx.activeRoot, args.initiative, 'bet');
      const bet = proposedBet(args, nextPlanId(args.initiative, 'B', bets), args.order ?? nextOrder(bets, args.week));
      return writePlanRecord(ctx.activeRoot, 'bet', bet);
    }),
});

const ListArgsSchema = z.object({
  initiative: z.string().min(1).optional(),
  week: shape.week.optional(),
  state: shape.state.default('selected'),
});

function byWeekThenOrder(a: Bet, b: Bet): number {
  return a.week.localeCompare(b.week) || a.order - b.order || a.id.localeCompare(b.id);
}

export const planBetList = defineCommand({
  name: 'plan.bet.list',
  description: "List bets in one state (default selected: the owner's picks), by week and order",
  args: ListArgsSchema,
  result: z.array(BetSchema),
  cli: {
    options: {
      initiative: { long: '--initiative', description: 'Initiative slug; omit to list across initiatives' },
      week: { long: '--week', description: 'Only bets for this ISO week, e.g. 2026-W47' },
      state: { long: '--state', description: 'proposed|selected|dropped|done (default selected)' },
    },
  },
  run: async (args, ctx) => {
    const bets = await listPlanRecords(ctx.activeRoot, 'bet', args.initiative);
    const shown = bets.filter((bet) => bet.state === args.state && (args.week === undefined || bet.week === args.week));
    return shown.sort(byWeekThenOrder);
  },
});
