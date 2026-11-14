import { Command } from "commander";
import { casesCommand } from "./cli-cases.js";
import { registerJudge } from "./cli-judge.js";
import { registerJudgePlan } from "./cli-judge-plan.js";
import { registerOracle } from "./cli-oracle.js";
import { registerPlanCases } from "./cli-plan-cases.js";
import { registerReport } from "./cli-report.js";
import { rescoreCommand } from "./cli-rescore.js";
import { runCommand } from "./cli-run.js";

/** One `.addCommand` line per bench verb; each verb lives in its own `cli-<verb>.ts`. */
export function benchCommand(onResult: (code: number) => void): Command {
  const program = new Command("bench")
    .description("The model-routing benchmark: run tracks of headless jobs under arms of model and effort")
    .addCommand(runCommand(onResult))
    .addCommand(casesCommand(onResult))
    .addCommand(rescoreCommand(onResult))
    .exitOverride();
  for (const register of [registerJudge, registerJudgePlan, registerPlanCases, registerOracle, registerReport]) register(program, onResult);
  return program;
}
