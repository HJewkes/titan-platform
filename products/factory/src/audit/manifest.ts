import type { StepDeclaration } from "../definition.js";

export type AuditStepName =
  | "load"
  | "inventory-data"
  | "inventory-code"
  | "purpose"
  | "answerability"
  | "propose"
  | "baseline"
  | "gaps"
  | "plan"
  | "review"
  | "publish";

export type AgentStepName = "inventory-code" | "purpose" | "propose" | "gaps" | "plan";

export interface ManifestStep {
  name: AuditStepName;
  runner: "code" | "agent" | "code+agent" | "hitl";
  /** Agent steps only, so a later search can try a cheaper model per step. */
  model?: "sonnet" | "opus";
  effort?: "medium" | "high";
  output: string;
}

/** The champion variant's manifest, design section 2. In a `code+agent` step the agent half is an earlier step's answer. */
export const AUDIT_MANIFEST: readonly ManifestStep[] = [
  { name: "load", runner: "code", output: "AuditContext" },
  { name: "inventory-data", runner: "code", output: "DataInventory" },
  { name: "inventory-code", runner: "agent", model: "sonnet", effort: "medium", output: "EmitterInventory" },
  { name: "purpose", runner: "agent", model: "opus", effort: "high", output: "Purpose" },
  { name: "answerability", runner: "code+agent", output: "QuestionCheck[]" },
  { name: "propose", runner: "agent", model: "opus", effort: "high", output: "MetricSpec[]" },
  { name: "baseline", runner: "code", output: "Baseline[]" },
  { name: "gaps", runner: "code+agent", model: "sonnet", effort: "medium", output: "Gap[]" },
  { name: "plan", runner: "agent", model: "sonnet", output: "SurfacePlan" },
  { name: "review", runner: "hitl", output: "gate answer" },
  { name: "publish", runner: "code", output: "report path" },
];

export const auditStepId = (name: AuditStepName): string => `audit-${name}`;

export function manifestStep(name: AuditStepName): ManifestStep {
  return AUDIT_MANIFEST.find((step) => step.name === name)!;
}

/** Prefixed ids, because the factory's routes are shared by every workflow it hosts. */
export const MEASUREMENT_AUDIT_STEPS: readonly StepDeclaration[] = AUDIT_MANIFEST.map((step) => ({
  id: auditStepId(step.name),
  kind: step.runner === "hitl" ? "assisted" : "dispatch",
}));
