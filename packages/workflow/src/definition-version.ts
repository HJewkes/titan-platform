import { announceRecovery, parkForRecovery } from "./recovery.js";
import type { WorkflowEvent, WorkflowFn, WorkflowRun } from "./types.js";

export interface Registration {
  fn: WorkflowFn;
  version?: string;
}

interface DriftHooks {
  emit: (event: WorkflowEvent) => void;
  save: (run: WorkflowRun) => void;
  park: (run: WorkflowRun) => void;
}

/** `version` is opaque (semver, git sha, content hash); an empty one could never be told apart from unpinned. */
export function registration(name: string, fn: WorkflowFn, version: string | undefined): Registration {
  if (version === "") throw new TypeError(`workflow ${name}: version must not be empty`);
  return { fn, ...(version === undefined ? {} : { version }) };
}

/** Evidence when a pinned run would replay a different definition over its memos; null when it may hydrate. */
function definitionDrift(run: WorkflowRun, registered: string | undefined): string | null {
  if (run.definitionVersion === undefined || run.definitionVersion === registered) return null;
  const now = registered === undefined ? "none" : JSON.stringify(registered);
  return `workflow ${run.workflowName} definition changed: run pinned ${JSON.stringify(run.definitionVersion)}, registered ${now}`;
}

/**
 * Parks a claimed run whose pin differs from the registered version and reports whether it did. An already-parked run
 * keeps its own evidence; it is still checked, because reconciling it would otherwise replay the new definition.
 */
export function parkOnDefinitionDrift(run: WorkflowRun, registered: string | undefined, hooks: DriftHooks): boolean {
  const evidence = definitionDrift(run, registered);
  if (!evidence) return false;
  if (run.status !== "recovery_required") {
    parkForRecovery(run, evidence);
    const step = Object.values(run.activeSteps)[0];
    if (step) announceRecovery(hooks.emit, run.id, step.stepId, evidence);
    try {
      hooks.save(run);
    } catch {
      // The row keeps its pin, so the next hydrate finds the same drift and parks it again.
    }
  }
  hooks.park(run);
  return true;
}
