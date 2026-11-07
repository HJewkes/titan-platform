import type { ShepherdPhases } from "./shepherd/phases.js";
import { DEFAULT_PHASES } from "./shepherd/pr.js";
import { configuredVisualSetCarry } from "./shepherd/visual-accept-adapter.js";

/** The config file is read per call, so a flag flipped while serve runs takes effect. */
export const factoryShepherdPhases: ShepherdPhases = { ...DEFAULT_PHASES, visualSetCarry: () => configuredVisualSetCarry() };
