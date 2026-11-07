import { configPath, loadConfig } from "../config.js";
import type { VisualSetCarry } from "./phases.js";

/** `shepherd.visualSetCarry` as the config file reads now; a config that does not parse offers nothing. */
export function configuredVisualSetCarry(env: NodeJS.ProcessEnv = process.env): VisualSetCarry {
  try {
    return loadConfig(configPath(env)).shepherd?.visualSetCarry ?? "off";
  } catch {
    return "off";
  }
}
