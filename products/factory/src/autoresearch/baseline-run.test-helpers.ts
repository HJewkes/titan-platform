import { ArResultSchema, arStepId, BoundsSchema, TargetSchema, type ArPorts } from "@titan-design/autoresearch";
import type { WorkflowRun } from "@titan-design/workflow";
import { onTestFinished } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { FORKS_SLEEPER } from "./eval-driver.test-helpers.js";
import { lastLine, runCommand } from "./run-command.js";
import { arRoutes } from "./routes.js";
import { autoresearchWorkflow } from "./workflow.js";

/** Ignores SIGTERM, so only the SIGKILL after its grace stops it; records its pid in `$0/children`. */
export const IGNORES_TERM = `trap "" TERM; echo $$ >> "$0/children"; while :; do sleep 0.1; done`;

/** Two baseline evals at once, as the recipe runs them: `b1` ignores TERM and sits out its grace, `b2` dies at TERM. */
function baselinePorts(dir: string): ArPorts {
  const unused = () => Promise.reject(new Error("not reached"));
  const metric = { primary: { name: "score", direction: "min" }, noise: {} };
  const target = TargetSchema.parse({ schema: "ar-target/v1", ratchetPrefix: "autoresearch/fixture", metric, phases: [{ id: "p1", train: ["t-1"], baselineRuns: 2, stop: { ideasEvaluated: 1, roundsWithoutGain: 1 } }] });
  const bounds = BoundsSchema.parse({ schema: "ar-bounds/v1", classes: {} });
  const evalCase: ArPorts["evalCase"] = async (input, signal) => {
    const argv = ["sh", "-c", input.key.endsWith("-b1") ? IGNORES_TERM : FORKS_SLEEPER, dir];
    return ArResultSchema.parse(lastLine(await runCommand(argv, { cwd: dir, signal, graceMs: 1_000 }), argv));
  };
  return {
    pin: async ({ pin }) => ({ pin, ratchetRef: "refs/heads/autoresearch/fixture/run", ratchetHead: pin, integrationTree: dir, target, bounds }),
    plan: unused, allocTree: unused, implement: unused, staticCheck: unused, micro: unused, ratchet: unused, releaseTree: unused,
    evalCase,
    now: Date.now,
  };
}

/** A factory host driving one autoresearch run whose two baseline evals record their pids in `dir`; closed when the test ends. */
export function baselineRun(dir: string): { host: FactoryHost; runId: string } {
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [autoresearchWorkflow()], routes: arRoutes(() => baselinePorts(dir)), gatePollMs: 5 });
  onTestFinished(() => host.close());
  return { host, runId: host.runtime.start("autoresearch", { pin: "a".repeat(40) }) };
}

export const evalRows = (run: WorkflowRun): string[] => Object.keys(run.stepResults).filter((key) => key.startsWith(arStepId("eval")));
