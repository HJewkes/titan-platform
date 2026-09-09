import type { StepResult } from "./types.js";

export type TemplateRenderer = (template: string, vars: Record<string, string>) => Promise<string> | string;

/**
 * The variables every step prompt can use: the run's params (as given and as
 * SNAKE_CASE), the workflow identity, and every completed step's output as
 * `STEP_OUTPUT_<STEP>` plus a combined `PREVIOUS_STEP_OUTPUTS` digest.
 */
export function buildStepVars(run: { id: string; workflowName: string; params: Record<string, string>; stepResults: Record<string, StepResult> }, extra: Record<string, string> = {}): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(run.params)) {
    vars[key] = value;
    const snake = key.replace(/([A-Z])/g, "_$1").toUpperCase().replace(/^_/, "");
    vars[snake] ??= value;
  }
  vars.WORKFLOW_NAME = run.workflowName;
  vars.RUN_ID = run.id;
  vars.INSTANCE_ID = run.id.slice(0, 8);
  const digest: string[] = [];
  for (const result of Object.values(run.stepResults)) {
    if (!result.output) continue;
    vars[`STEP_OUTPUT_${result.stepId.toUpperCase().replace(/-/g, "_")}`] = result.output;
    digest.push(`### ${result.stepId}\n\n${result.output}`);
  }
  if (digest.length > 0) vars.PREVIOUS_STEP_OUTPUTS = digest.join("\n\n---\n\n");
  return { ...vars, ...extra };
}

/** `{{NAME}}` substitution; unknown names are left in place so a missing variable is visible in the prompt. */
export const mustacheRenderer: TemplateRenderer = (template, vars) =>
  template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, name: string) => vars[name] ?? whole);
