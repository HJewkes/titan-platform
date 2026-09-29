import type { StepDeclaration } from "../definition.js";
import type { StepRoute } from "../routed-runner.js";
import type { ShepherdPhases } from "./phases.js";

export const WAKE_STEPS: readonly StepDeclaration[] = [];

export const wakeRoutes = (): readonly StepRoute[] => [];

export const wakePhase: ShepherdPhases["wake"] = async () => ({ kind: "unhandled", reason: "wake phase not implemented" });
