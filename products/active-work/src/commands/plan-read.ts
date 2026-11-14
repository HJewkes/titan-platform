import { z } from 'zod';
import { defineCommand, type CommandContext } from '../registry/index.js';
import {
  assertInitiativeExists,
  loadPlanRecord,
  loadPlanRecords,
  loadVisiblePlanRecords,
  planSchema,
  type PlanKind,
  type PlanRecords,
} from '../plan/store.js';

/*
 * Reads of the plan store, the same for every record kind. A named id or --initiative reads that initiative by path;
 * a list across initiatives skips owner-only ones, as the other cross-initiative readers do (TP-5453 P6).
 */

const ShowArgsSchema = z.object({ id: z.string().min(1) });

const ListArgsSchema = z.object({ initiative: z.string().min(1).optional() });

/** One initiative's records when named, else those of every initiative the caller may list. */
export async function listPlanRecords<K extends PlanKind>(
  ctx: CommandContext,
  kind: K,
  initiative?: string,
): Promise<PlanRecords[K][]> {
  if (initiative === undefined) return loadVisiblePlanRecords(ctx, kind);
  await assertInitiativeExists(ctx.activeRoot, initiative);
  return loadPlanRecords(ctx.activeRoot, initiative, kind);
}

function showCommand<K extends PlanKind>(kind: K, example: string) {
  return defineCommand({
    name: `plan.${kind}.show`,
    description: `Show one ${kind} record from an initiative's plan by id (e.g. ${example})`,
    args: ShowArgsSchema,
    result: planSchema(kind),
    cli: { positional: ['id'] },
    run: async (args, ctx) => loadPlanRecord(ctx.activeRoot, kind, args.id),
  });
}

function listCommand<K extends PlanKind>(kind: K) {
  return defineCommand({
    name: `plan.${kind}.list`,
    description: `List ${kind} records for one initiative, or across every agent-visible initiative`,
    args: ListArgsSchema,
    result: z.array(planSchema(kind)),
    cli: {
      options: { initiative: { long: '--initiative', description: 'Initiative slug; omit to list across initiatives' } },
    },
    run: async (args, ctx) => listPlanRecords(ctx, kind, args.initiative),
  });
}

export const planOutcomeShow = showCommand('outcome', 'alpha/faster-landing');
export const planOutcomeList = listCommand('outcome');
export const planBetShow = showCommand('bet', 'alpha/B1');
export const planFreezeShow = showCommand('freeze', 'alpha/F1');
export const planFreezeList = listCommand('freeze');
export const planOutOfScopeShow = showCommand('out-of-scope', 'alpha/X1');
export const planOutOfScopeList = listCommand('out-of-scope');
