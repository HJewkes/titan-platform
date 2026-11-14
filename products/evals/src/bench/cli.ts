import { Command } from "commander";
import { runCommand } from "./cli-run.js";

/** One `.addCommand` line per bench verb; each verb lives in its own `cli-<verb>.ts`. */
export function benchCommand(onResult: (code: number) => void): Command {
  return new Command("bench")
    .description("The model-routing benchmark: run tracks of headless jobs under arms of model and effort")
    .addCommand(runCommand(onResult))
    .exitOverride();
}
