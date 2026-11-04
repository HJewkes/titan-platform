import type { RestartRule } from "@titan-design/workflow";
import type { StepDeclaration } from "../definition.js";

export const BUILD_SURFACE_WORKFLOW = "build-surface";

/**
 * Every dispatch step and the rule a restart applies to it. Agent steps that write (implement, fix) and the deploy
 * park, because an agent may be mid-push or a deploy half-done; every other step reads before it writes.
 */
export const DISPATCH_STEPS: Readonly<Record<string, RestartRule>> = {
  "bs-plan": "repeat",
  "bs-preflight": "repeat",
  "bs-extract": "repeat",
  "bs-extract-check": "repeat",
  "bs-branch": "repeat",
  "bs-implement": "park",
  "bs-report-check": "repeat",
  "bs-gates": "repeat",
  "bs-health": "repeat",
  "bs-file-task": "repeat",
  "bs-preview": "repeat",
  "bs-review": "repeat",
  "bs-review-check": "repeat",
  "bs-fix": "park",
  "bs-pr": "repeat",
  "bs-shepherd": "repeat",
  "bs-await-land": "repeat",
  "bs-deploy": "park",
};

/** The gates the owner answers: a device check on the preview, an infra failure a retry did not clear, a deploy approval, and the one final walk. */
export const DEVICE_CHECK = "device-check";
export const INFRA_PARK = "infra-park";
export const DEPLOY_APPROVE = "deploy-approve";
export const FINAL_WALK = "final-walk";

export const BUILD_SURFACE_STEPS: readonly StepDeclaration[] = [
  ...Object.keys(DISPATCH_STEPS).map((id) => ({ id, kind: "dispatch" as const })),
  { id: DEVICE_CHECK, kind: "assisted" },
  { id: INFRA_PARK, kind: "assisted" },
  { id: DEPLOY_APPROVE, kind: "assisted" },
  { id: FINAL_WALK, kind: "assisted" },
];
