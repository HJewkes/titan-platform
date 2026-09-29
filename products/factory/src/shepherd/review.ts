import type { StepDeclaration } from "../definition.js";
import type { StepRoute } from "../routed-runner.js";
import type { ShepherdPhases } from "./phases.js";

export const REVIEW_STEPS: readonly StepDeclaration[] = [];

export const reviewRoutes = (): readonly StepRoute[] => [];

export const reviewPhase: ShepherdPhases["review"] = async () => ({ kind: "none" });
