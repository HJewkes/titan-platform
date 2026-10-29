import { z } from "zod";
import { OPS } from "./ops.js";
import { lintSlices, sliceWarnings } from "./slice-lint.js";

/** A planner's `burndown-slices` block. The report a tick-spawned agent leaves is read by session-analytics' `parseReport`. */

const CONTRACT_OPS = ["replace", "remove", "rename", "migrate", "add", "extend", "modify"] as const;

const Contract = z.object({
  scope: z.string().trim().min(1),
  op: z.enum(CONTRACT_OPS),
});
type Contract = z.infer<typeof Contract>;

const PlannedSlice = z.object({
  n: z.string().min(1),
  title: z.string(),
  dependsOn: z.array(z.string()).default([]),
  owns: z.array(z.string()).default([]),
  /** The checkout's basename or path when the work is not in the task's own repo. */
  repo: z.string().optional(),
  points: z.number().optional(),
  doneWhen: z.string().optional(),
  contracts: z.array(Contract).default([]),
  /** The ops the slice's doneWhen names; `[]` says its hits are subject matter. */
  ops: z.array(z.enum(OPS)).optional(),
  /** The semantic reason a slice waits on one whose owns it does not share. */
  dependsWhy: z.string().optional(),
});
/** `contracts` is optional on the type so fixtures built by hand stay valid; `readSlices` always fills it. */
export type PlannedSlice = Omit<z.infer<typeof PlannedSlice>, "contracts"> & { contracts?: Contract[] };

/** A planner's slices and their advisory lines when they pass the lint, else the reason lines. */
type SliceRead =
  | { slices: PlannedSlice[]; warnings: string[]; problems?: undefined }
  | { slices?: undefined; warnings?: undefined; problems: string[] };

const SLICES_BLOCK = /^```burndown-slices[ \t]*\n([\s\S]*?)^```[ \t]*$/m;

/** The planner's slices, or why the plan's `burndown-slices` block is missing, unreadable, or fails the lint. */
export function readSlices(planText: string): SliceRead {
  const body = SLICES_BLOCK.exec(planText)?.[1];
  if (body === undefined) return { problems: ["plan has no burndown-slices block"] };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (err) {
    return { problems: [`burndown-slices block is not JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const parsed = z.array(PlannedSlice).min(1).safeParse(json);
  if (!parsed.success) return { problems: parsed.error.issues.map(shapeProblem) };
  const problems = lintSlices(parsed.data);
  return problems.length === 0 ? { slices: parsed.data, warnings: sliceWarnings(parsed.data) } : { problems };
}

const shapeProblem = (issue: z.core.$ZodIssue): string =>
  issue.path.length === 0 ? `burndown-slices block: ${issue.message}` : `burndown-slices block at ${issue.path.join(".")}: ${issue.message}`;

/** True for a plan that is sliced, even when its block is unreadable or fails the lint. */
export const hasSlicesBlock = (planText: string): boolean => SLICES_BLOCK.test(planText);

/** The planner's slices, or undefined when `readSlices` finds a problem. */
export const parseSlices = (planText: string): PlannedSlice[] | undefined => readSlices(planText).slices;
