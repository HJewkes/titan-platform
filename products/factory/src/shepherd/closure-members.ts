import { workspaceRoot } from "../registry/bumps.js";
import { isFactEntry } from "../registry/entry.js";
import { closureOf } from "../registry/closure.js";
import { entryFor } from "../registry/registry.js";
import { factoryRegistry } from "../registry/steps/index.js";

/** The files a step's closure holds, or undefined for a step the registry has no fact entry for. */
export type ClosureMembers = (step: string) => readonly string[] | undefined;

/** Read from the checkout this code runs from, so a file the PR newly pulls into the closure is not listed. */
export const registryClosureMembers: ClosureMembers = (step) => {
  const entry = entryFor(factoryRegistry, step);
  return entry && isFactEntry(entry) ? closureOf(workspaceRoot(), entry.body).files : undefined;
};
