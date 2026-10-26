import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeDeposit } from "@titan-design/owner-queue/spool";
import { withdrawMatching } from "@titan-design/owner-queue/withdraw";
import type { Command } from "commander";
import type { Verbs } from "../cli.js";
import { factoryStateDir } from "../config.js";
import { ownerInboxDir } from "../deploy-watch-ports.js";
import { PLANNER_ALARM_ASKER, PLANNER_ALARM_KEYS } from "./alarm.js";
import { loadPlannerConfig } from "./config.js";
import { runProcess, type PlannerRun } from "./inputs.js";
import { plannerWake, type PlannerAlarmPort } from "./wake.js";

/** What `planner wake` runs agent-chat, gh and input commands through, and reads and waits on the time with; defaults to the machine. */
export interface PlannerDeps {
  run?: PlannerRun;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** The owner inbox spool the titan console reads, which `titan-console inbox file -` feeds too. */
function inboxAlarm(env: NodeJS.ProcessEnv): PlannerAlarmPort {
  const inbox = ownerInboxDir(env);
  const match = { asker: PLANNER_ALARM_ASKER, actor: PLANNER_ALARM_ASKER, keys: PLANNER_ALARM_KEYS, reason: "resolved" };
  return {
    file: async (deposit) => void (await writeDeposit(inbox, deposit)),
    resolve: async () => (await withdrawMatching(inbox, match)).length,
  };
}

/** `titan-factory planner wake`: the factory-planner timer's entry, gated on a fingerprint of the planner's inputs. */
export function registerPlanner(program: Command, verbs: Verbs): void {
  program
    .command("planner")
    .description("the scheduled factory-planner review")
    .command("wake")
    .description("spawn a fresh factory-planner and wait for its review, or exit 0 with one line when nothing it reads has changed since the last run")
    .requiredOption("--config <path>", "planner wake config (JSON: brief, cwd, inputs, profile, reviewDir)")
    .option("--profile <name>", "agent-chat profile to spawn the planner on (overrides the config)")
    .action(async (opts: { config: string; profile?: string }) => {
      const config = loadPlannerConfig(opts.config);
      const { io, deps } = verbs;
      const code = await plannerWake(
        { ...config, profile: opts.profile ?? config.profile },
        {
          run: deps.planner?.run ?? runProcess,
          now: deps.planner?.now ?? (() => new Date()),
          sleep: deps.planner?.sleep ?? ((ms) => delay(ms)),
          stateDir: join(factoryStateDir(io.env), "planner-wake"),
          alarm: inboxAlarm(io.env),
          log: (line) => io.stdout(`${line}\n`),
        },
      );
      verbs.setExit(code);
    });
}
