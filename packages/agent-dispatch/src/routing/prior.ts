import { z } from "zod";
import { classifyTask, profileFor, type TaskFacts } from "./classify.js";
import type { WorkflowTable } from "./table.js";

/**
 * The implementer profile a task-time prior gives a dispatch. `off` reads nothing; `shadow` keeps today's profile
 * and notes the change `on` would make; `on` routes by the prior.
 */

export const PRIOR_ROUTINGS = ["off", "shadow", "on"] as const;
export type PriorRouting = (typeof PRIOR_ROUTINGS)[number];

export interface PriorRouter {
  mode: Exclude<PriorRouting, "off">;
  table: WorkflowTable;
}

export interface Routed {
  profile: string;
  note?: string;
}

/** The profiles a dispatcher can spawn as an implementer; a prior naming any other keeps today's. */
export const DISPATCHABLE: readonly string[] = ["bd-implementer-lite", "bd-implementer"];

/** The profile for a dispatch whose route today gives `today`, and the note when the prior would change it. */
export function priorRoute(router: PriorRouter, facts: TaskFacts, today: string, label: string): Routed {
  const { prior, reason } = classifyTask(router.table, facts);
  const wanted = profileFor(router.table, prior, facts.estimate);
  if (!DISPATCHABLE.includes(wanted) || wanted === today) return { profile: today };
  const change = `${label}: ${today} -> ${wanted} (prior ${prior}: ${reason})`;
  return router.mode === "on"
    ? { profile: wanted, note: `route-change ${change}` }
    : { profile: today, note: `would-route ${change}` };
}

export interface PlanFacts {
  owns: string[];
  points?: number;
}

const SLICES_BLOCK = /^```burndown-slices[ \t]*\n([\s\S]*?)^```[ \t]*$/m;

/** Only the fields routing reads; the planner's full slice lint stays with the dispatcher that runs the plan. */
const plannedSliceSchema = z.object({
  n: z.string().min(1),
  owns: z.array(z.string()).default([]),
  points: z.number().optional(),
});

type PlannedSlice = z.infer<typeof plannedSliceSchema>;

function planSlices(planText: string): PlannedSlice[] {
  const body = SLICES_BLOCK.exec(planText)?.[1];
  if (body === undefined) return [];
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  const parsed = z.array(plannedSliceSchema).min(1).safeParse(json);
  return parsed.success ? parsed.data : [];
}

/** The union of the plan's slice owns, or the named slice's owns and points; empty with no plan or a failing one. */
export function planFacts(planText: string | undefined, slice?: string): PlanFacts {
  const slices = planText === undefined ? [] : planSlices(planText);
  if (slice === undefined) return { owns: [...new Set(slices.flatMap((s) => s.owns))] };
  const named = slices.find((s) => s.n === slice);
  if (named === undefined) return { owns: [] };
  return named.points === undefined ? { owns: named.owns } : { owns: named.owns, points: named.points };
}
