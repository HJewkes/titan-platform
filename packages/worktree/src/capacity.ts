import path from "node:path";
import { WorktreeBudgetExhaustedError } from "./errors.js";
import { allocatedPaths } from "./layout.js";
import { basePathOf, budgetOf, slug, type WorktreeOptions } from "./options.js";

/** Count discovered trees using host policy, never a second ownership table. */
export async function capacityError(gitRoot: string, agentName: string, opts: WorktreeOptions): Promise<Error | undefined> {
  const name = slug(agentName);
  const paths = await allocatedPaths(gitRoot, basePathOf(opts));
  const group = opts.allocationGroup;
  const allocated = group === undefined ? paths.length : paths.filter((dir) => group(slug(path.basename(dir))) === group(name)).length;
  const budget = budgetOf(opts, name);
  if (!(allocated >= budget)) return undefined;
  return opts.budgetError?.(allocated, budget, name) ?? new WorktreeBudgetExhaustedError(allocated, budget);
}
