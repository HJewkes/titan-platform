import type { CapabilityVault } from "./capabilities.js";
import type { ContextDeps } from "./context-deps.js";
import { buildStepVars } from "./prompt.js";
import type { WorkflowRun } from "./types.js";

/** Renders a dispatch prompt, refusing secrets in the variables and in the rendered text before anything runs. */
export async function renderGuarded(deps: ContextDeps, run: WorkflowRun, stepId: string, template: string, extra: Record<string, string> | undefined): Promise<string> {
  const vault: CapabilityVault | undefined = deps.capabilities;
  const vars = buildStepVars(run, extra);
  vault?.refuse(vars, `${stepId} prompt vars`);
  const prompt = await deps.render(template, vars);
  vault?.refuse(prompt, `${stepId} prompt`);
  return prompt;
}
