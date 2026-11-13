import { ITEM_KINDS, LENSES, type OwnerItem } from "@titan-design/owner-queue";
import { defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { FactoryContext, NeedsSources } from "../context.js";
import { ownerQueueSources } from "./command.js";
import { collectNeeds } from "./merged.js";

const needsFilterSchema = z.object({
  kind: z.enum(ITEM_KINDS).optional(),
  lens: z.enum(LENSES).optional(),
  initiative: z.string().min(1).optional(),
  personal: z.boolean().optional().describe("include personal initiatives; left out unless true"),
});

type NeedsFilter = z.infer<typeof needsFilterSchema>;

const needsListSchema = needsFilterSchema.extend({
  fyi: z.enum(["include", "count"]).optional().describe("count leaves open `lens: fyi` items out and returns only how many there were; include, the default, lists them"),
});

type NeedsListArgs = z.infer<typeof needsListSchema>;

interface NeedsListResult {
  items: OwnerItem[];
  /** One line per source that could not be read, so an outage is never an empty queue. */
  gaps: string[];
  /** Set only under `fyi: "count"`: the fyi items left out, which outnumber the asks by far and which the console only counts. */
  fyiCount?: number;
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
  const ownerOnly = ctx.caller === "owner";
  const list = await collectNeeds(await (ctx.needsSources ?? liveSources(ctx))({ personal }), { personal, ownerOnly });
  return { items: list.items.filter((item) => matches(item, filter)), gaps: list.gaps };
}

function countBy(items: readonly OwnerItem[], field: "kind" | "lens"): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item[field]] = (counts[item[field]] ?? 0) + 1;
  return counts;
}

/** Matches what the console counts: an answered fyi item still travels, since consolidate reads answers. */
const isOpenFyi = (item: OwnerItem): boolean => item.lens === "fyi" && item.status === "open";

async function listNeeds({ fyi, ...filter }: NeedsListArgs, ctx: FactoryContext): Promise<NeedsListResult> {
  const read = await readNeeds(filter, ctx);
  if (fyi !== "count") return read;
  const sent = read.items.filter((item) => !isOpenFyi(item));
  return { items: sent, gaps: read.gaps, fyiCount: read.items.length - sent.length };
}

const list = defineCommand<NeedsListArgs, NeedsListResult, FactoryContext>({
  name: "needs.list",
  description: "Everything waiting on the owner as merged OwnerItem[], the set `titan-factory needs --json` prints, filtered by kind, lens or initiative; personal initiatives only when asked; owner-only initiatives only for the owner; `fyi: count` leaves fyi items out and counts them",
  args: needsListSchema,
  result: z.custom<NeedsListResult>(),
  run: listNeeds,
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
