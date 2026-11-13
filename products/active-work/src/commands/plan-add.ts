import {
  FreezeSchema,
  OutcomeSchema,
  OutOfScopeSchema,
  type FreezeEndCondition,
  type OwnerIntentRef,
} from '@titan-design/pm';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { UsageError } from '../errors.js';
import { today } from '../utils/today.js';
import { loadPlanRecords, nextPlanId, planRecordExists, withPlanLock, writePlanRecord } from '../plan/store.js';

/*
 * Adds for outcomes, freezes and out-of-scope records. An outcome is written once, as a draft: any later change to it
 * is an owner action and arrives as a console owner operation (TP-5453 P3b), not here.
 */

const text = z.string().min(1);

const INTENT_OPTIONS = {
  intent_ref: { long: '--intent-ref', description: 'Decision id (D12) or intent line id (alpha/I3) holding the words' },
  quote_ref: { long: '--quote-ref', description: 'Reference to the exact quote, e.g. msg:abc123' },
};

const OutcomeArgsSchema = z.object({
  initiative: text,
  slug: text,
  statement: text,
  measure: text,
  intent_ref: text.optional(),
  quote_ref: text.optional(),
});

function optionalIntent(args: { intent_ref?: string; quote_ref?: string }): OwnerIntentRef | undefined {
  const { intent_ref, quote_ref } = args;
  if (intent_ref === undefined && quote_ref === undefined) return undefined;
  if (intent_ref === undefined || quote_ref === undefined) {
    throw new UsageError('Pass --intent-ref and --quote-ref together');
  }
  return { intent_ref, quote_ref };
}

export const planOutcomeAdd = defineCommand({
  name: 'plan.outcome.add',
  description: 'Write the first, draft version of an outcome; refused when the outcome already exists',
  args: OutcomeArgsSchema,
  result: OutcomeSchema,
  cli: {
    positional: ['initiative', 'slug'],
    options: {
      statement: { long: '--statement', description: 'What the owner would notice', required: true },
      measure: { long: '--measure', description: 'How it is measured', required: true },
      ...INTENT_OPTIONS,
    },
  },
  run: async (args, ctx) =>
    withPlanLock(ctx.activeRoot, args.initiative, async () => {
      const id = `${args.initiative}/${args.slug}`;
      if (await planRecordExists(ctx.activeRoot, 'outcome', id)) {
        throw new UsageError(`Outcome already exists: ${id}; changing it is an owner action`);
      }
      const { initiative, statement, measure } = args;
      const owner_intent = optionalIntent(args);
      return writePlanRecord(ctx.activeRoot, 'outcome', { id, initiative, statement, measure, state: 'draft', owner_intent });
    }),
});

const END_FORMS = 'owner, date:<YYYY-MM-DD>, task-done:<initiative>/<ID> or measure:<metric>:<increase|decrease>:<n>';

/** Parses --ends; the freeze schema then checks each part. */
function parseEndCondition(raw: string): FreezeEndCondition {
  if (raw === 'owner') return { kind: 'owner' };
  const [kind, ...rest] = raw.split(':');
  const value = rest.join(':');
  if (kind === 'date') return { kind, date: value };
  if (kind === 'task-done') return { kind, task: value };
  const measure = /^measure:(.+):(increase|decrease):(-?\d+(?:\.\d+)?)$/.exec(raw);
  if (measure !== null) {
    const [, metric, direction, threshold] = measure;
    return { kind: 'measure', metric, direction: direction === 'increase' ? 'increase' : 'decrease', threshold: Number(threshold) };
  }
  throw new UsageError(`--ends must be one of ${END_FORMS}: ${raw}`);
}

const FreezeArgsSchema = z.object({
  initiative: text,
  tag: text.optional(),
  selector: text.optional(),
  reason: text,
  ends: text,
  set_by: FreezeSchema.shape.set_by,
  intent_ref: text,
  quote_ref: text,
});

export const planFreezeAdd = defineCommand({
  name: 'plan.freeze.add',
  description: 'Freeze the tasks under one tag or selector until an end condition holds',
  args: FreezeArgsSchema,
  result: FreezeSchema,
  cli: {
    positional: ['initiative'],
    options: {
      tag: { long: '--tag', description: 'Freeze tasks with this tag (or pass --selector)' },
      selector: { long: '--selector', description: 'Freeze tasks matching this selector (or pass --tag)' },
      reason: { long: '--reason', description: 'Why the work is frozen', required: true },
      ends: { long: '--ends', description: `End condition: ${END_FORMS}`, required: true },
      set_by: { long: '--set-by', description: 'owner|decider', required: true },
      intent_ref: { ...INTENT_OPTIONS.intent_ref, required: true },
      quote_ref: { ...INTENT_OPTIONS.quote_ref, required: true },
    },
  },
  run: async (args, ctx) =>
    withPlanLock(ctx.activeRoot, args.initiative, async () => {
      const { initiative, tag, selector, reason, set_by, intent_ref, quote_ref } = args;
      const id = nextPlanId(initiative, 'F', await loadPlanRecords(ctx.activeRoot, initiative, 'freeze'));
      const end_condition = parseEndCondition(args.ends);
      const freeze = { id, initiative, tag, selector, reason, end_condition, set_by, intent_ref, quote_ref };
      return writePlanRecord(ctx.activeRoot, 'freeze', freeze);
    }),
});

const OutOfScopeArgsSchema = z.object({
  initiative: text,
  statement: text,
  intent_ref: text,
  quote_ref: text,
  date: text.optional(),
  revisit_when: text.optional(),
});

export const planOutOfScopeAdd = defineCommand({
  name: 'plan.out-of-scope.add',
  description: 'Record work the owner ruled out, with the reference to the statement that did so',
  args: OutOfScopeArgsSchema,
  result: OutOfScopeSchema,
  cli: {
    positional: ['initiative'],
    options: {
      statement: { long: '--statement', description: 'The work that is out of scope', required: true },
      intent_ref: { ...INTENT_OPTIONS.intent_ref, required: true },
      quote_ref: { ...INTENT_OPTIONS.quote_ref, required: true },
      date: { long: '--date', description: 'Date of the statement, YYYY-MM-DD (default today)' },
      revisit_when: { long: '--revisit-when', description: 'When to look at it again' },
    },
  },
  run: async (args, ctx) =>
    withPlanLock(ctx.activeRoot, args.initiative, async () => {
      const { initiative, statement, intent_ref, quote_ref, revisit_when } = args;
      const id = nextPlanId(initiative, 'X', await loadPlanRecords(ctx.activeRoot, initiative, 'out-of-scope'));
      const record = { id, initiative, statement, intent_ref, quote_ref, date: args.date ?? today(), revisit_when };
      return writePlanRecord(ctx.activeRoot, 'out-of-scope', record);
    }),
});
