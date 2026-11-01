import { createRegistry, entryFor } from "../registry.js";
import { auditSteps } from "./audit.js";
import { buildSurfaceSteps } from "./build-surface.js";
import { coreSteps } from "./core.js";
import { gateSteps } from "./gates.js";
import { seedFactSteps } from "./seed-facts.js";
import { shepherdSteps } from "./shepherd.js";

/** One entry per step id the factory workflows declare; a step shared by several workflows has one entry. */
export const factoryRegistry: ReturnType<typeof createRegistry> = createRegistry([...coreSteps, ...shepherdSteps, ...auditSteps, ...buildSurfaceSteps, ...gateSteps, ...seedFactSteps]);

/** The runtime's `abandonsOrphan` predicate: a read's orphan is dropped on restart, every other class parks. */
export function abandonsOrphan(stepId: string): boolean {
  return entryFor(factoryRegistry, stepId)?.effect.class === "read";
}
