import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isFactEntry } from "../registry/entry.js";
import { closureOf } from "../registry/closure.js";
import { entryFor } from "../registry/registry.js";
import { factoryRegistry } from "../registry/steps/index.js";

/** The files a step's closure holds, or undefined for a step the registry has no fact entry for. */
export type ClosureMembers = (step: string) => readonly string[] | undefined;

function workspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "pnpm-workspace.yaml")) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

/** Read from the checkout this code runs from, so a file the PR newly pulls into the closure is not listed. */
export const registryClosureMembers: ClosureMembers = (step) => {
  const entry = entryFor(factoryRegistry, step);
  return entry && isFactEntry(entry) ? closureOf(workspaceRoot(), entry.body).files : undefined;
};
