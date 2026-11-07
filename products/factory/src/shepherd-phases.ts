import type { WorkflowDefinition } from "./definition.js";
import type { ShepherdPhases } from "./shepherd/phases.js";
import { DEFAULT_PHASES, shepherdPrWorkflow } from "./shepherd/pr.js";
import { configuredVisualSetCarry } from "./shepherd/visual-accept-adapter.js";

/** The config file is read per call, so a flag flipped while serve runs takes effect. */
export const factoryShepherdPhases: ShepherdPhases = { ...DEFAULT_PHASES, visualSetCarry: () => configuredVisualSetCarry() };

/** The production shepherd-pr workflow, composed here so the hold that covers this file covers the phases it runs. */
export const factoryShepherdWorkflow = (): WorkflowDefinition => shepherdPrWorkflow(factoryShepherdPhases);
