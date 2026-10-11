import { ITEM_KINDS, LENSES, type OwnerItem, type QueueSource } from "@titan-design/owner-queue";
import { defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { FactoryContext } from "../registry.js";
import { ownerQueueSources } from "./command.js";
import { collectNeeds } from "./merged.js";

/** The owner-queue adapters a needs read merges; `personal` asks the active-work source for charter-personal initiatives too. */
export type NeedsSources = (options: { personal: boolean }) => readonly QueueSource[] | Promise<readonly QueueSource[]>;

const needsFilterSchema = z.object({
  kind: z.enum(ITEM_KINDS).optional(),
  lens: z.enum(LENSES).optional(),
  initiative: z.string().min(1).optional(),
  personal: z.boolean().optional().describe("include personal initiatives; left out unless true"),
});

type NeedsFilter = z.infer<typeof needsFilterSchema>;

interface NeedsListResult {
  items: OwnerItem[];
  /** One line per source that could not be read, so an outage is never an empty queue. */
  gaps: string[];
}

interface NeedsCountResult {
  total: number;
  byKind: Record<string, number>;
  byLens: Record<string, number>;
  gaps: string[];
}

const liveSources = (ctx: FactoryContext): NeedsSources => ({ personal }) => ownerQueueSources(process.env, ctx.host.gates, { includePersonal: personal });

function matches(item: OwnerItem, filter: NeedsFilter): boolean {
  return (filter.kind === undefined || item.kind === filter.kind)
    && (filter.lens === undefined || item.lens === filter.lens)
    && (filter.initiative === undefined || item.initiative === filter.initiative);
}

async function readNeeds(filter: NeedsFilter, ctx: FactoryContext): Promise<NeedsListResult> {
  const personal = filter.personal === true;
  const list = await collectNeeds(await (ctx.needsSources ?? liveSources(ctx))({ personal }), { personal });
  return { items: list.items.filter((item) => matches(item, filter)), gaps: list.gaps };
}

function countBy(items: readonly OwnerItem[], field: "kind" | "lens"): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item[field]] = (counts[item[field]] ?? 0) + 1;
  return counts;
}

const list = defineCommand<NeedsFilter, NeedsListResult, FactoryContext>({
  name: "needs.list",
  description: "Everything waiting on the owner as merged OwnerItem[], the set `titan-factory needs --json` prints, filtered by kind, lens or initiative; personal initiatives only when asked",
  args: needsFilterSchema,
  result: z.custom<NeedsListResult>(),
  run: readNeeds,
});

const count = defineCommand<NeedsFilter, NeedsCountResult, FactoryContext>({
  name: "needs.count",
  description: "How many merged owner items wait, in total and by kind and lens, under the same filters as needs.list",
  args: needsFilterSchema,
  result: z.custom<NeedsCountResult>(),
  async run(filter, ctx) {
    const { items, gaps } = await readNeeds(filter, ctx);
    return { total: items.length, byKind: countBy(items, "kind"), byLens: countBy(items, "lens"), gaps };
  },
});

export const NEEDS_COMMANDS = [list, count];
