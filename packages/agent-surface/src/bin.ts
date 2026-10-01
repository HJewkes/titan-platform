#!/usr/bin/env node
import path from "node:path";
import { parseLaunchArgs } from "./launch-args.js";
import { readLaunchPlan, runAgent } from "./run-agent.js";

const parsed = parseLaunchArgs(process.argv.slice(2));
if ("error" in parsed) {
  process.stderr.write(`titan-agent-launch: ${parsed.error}\n`);
  process.exit(64);
}

try {
  const plan = readLaunchPlan(parsed.planFile);
  runAgent(plan, {
    agentDir: path.dirname(parsed.planFile),
    ...(parsed.launcherPidEnv === undefined ? {} : { launcherPidEnv: parsed.launcherPidEnv }),
  });
} catch (err) {
  process.stderr.write(`titan-agent-launch: ${(err as Error).message}\n`);
  process.exit(66);
}
