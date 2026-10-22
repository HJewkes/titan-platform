import { join } from "node:path";
import type { Command } from "commander";
import type { Verbs } from "../cli.js";
import { factoryStateDir } from "../config.js";
import { loadPlannerConfig } from "./config.js";
import { runProcess, type PlannerRun } from "./inputs.js";
import { plannerWake } from "./wake.js";

/** What `planner wake` runs agent-chat, gh and input commands through, and reads the time from; defaults to the machine. */
export interface PlannerDeps {
  run?: PlannerRun;
  now?: () => Date;
}

/** `titan-factory planner wake`: the factory-planner timer's entry, gated on a fingerprint of the planner's inputs. */
export function registerPlanner(program: Command, verbs: Verbs): void {
  program
    .command("planner")
    .description("the scheduled factory-planner review")
    .command("wake")
    .description("spawn a fresh factory-planner, or exit 0 with one line when nothing it reads has changed since the last run")
    .requiredOption("--config <path>", "planner wake config (JSON: brief, cwd, inputs, profile)")
    .option("--profile <name>", "agent-chat profile to spawn the planner on (overrides the config)")
    .action(async (opts: { config: string; profile?: string }) => {
      const config = loadPlannerConfig(opts.config);
      const { io, deps } = verbs;
      const code = await plannerWake(
        { ...config, profile: opts.profile ?? config.profile },
        {
          run: deps.planner?.run ?? runProcess,
          now: deps.planner?.now ?? (() => new Date()),
          stateDir: join(factoryStateDir(io.env), "planner-wake"),
          log: (line) => io.stdout(`${line}\n`),
        },
      );
      verbs.setExit(code);
    });
}
