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

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** `{{NAME}}` substitution; unknown names are left in place so a missing variable is visible in the prompt. */
export const mustacheRenderer: TemplateRenderer = (template, vars) => template.replace(PLACEHOLDER, (whole, name: string) => vars[name] ?? whole);

/** Read from the template, not the rendered prompt, so a `{{NAME}}` inside a substituted value never counts as unfilled. */
export function unfilledVariables(template: string, vars: Record<string, string>): string[] {
  const names = new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1]!));
  return [...names].filter((name) => !Object.hasOwn(vars, name)).sort();
}
