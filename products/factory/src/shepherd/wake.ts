import type { StepDeclaration } from "../definition.js";
import type { StepRoute } from "../routed-runner.js";
import type { ShepherdDeps, ShepherdPhases } from "./phases.js";

export const WAKE_STEPS: readonly StepDeclaration[] = [];

export const wakeRoutes = (_deps: ShepherdDeps): readonly StepRoute[] => [];

export const wakePhase: ShepherdPhases["wake"] = async () => ({ kind: "unhandled", reason: "wake phase not implemented" });
