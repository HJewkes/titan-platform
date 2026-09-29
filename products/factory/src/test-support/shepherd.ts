import { fakeGitHub, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { invokeCommand, type JsonEnvelope } from "@titan-design/registry";
import type { WorkflowDefinition } from "../definition.js";
import type { FactoryHost, FactoryRoutes } from "../host.js";
import { createFactoryRegistry, factoryContext } from "../registry.js";
import type { ShepherdPhases } from "../shepherd/phases.js";
import { shepherdPrWorkflow } from "../shepherd/pr.js";
import type { SeatBook } from "../shepherd/seats.js";
import { shepherdStoreRef } from "../shepherd/store.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { landPrWorkflow } from "../workflows/land-pr.js";

export const BRANCH = "agent-chat/demo-1";

/** Review says none and every wake is unhandled, so an owner-gated run parks on approve-merge. */
const IDLE_PHASES: ShepherdPhases = {
  wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
  review: async () => ({ kind: "none" }),
};

export interface ShepherdFixture {
  fake: FakeGitHub;
  routes: FactoryRoutes;
  workflows: WorkflowDefinition[];
}

export interface FixtureOptions {
  seats?: SeatBook;
  /** Polls never come back, so a run waiting on `sh-await-pr` stays there after its first read. */
  frozen?: boolean;
}

/** A fake GitHub whose checks pass on every head, and the factory routes over it on a fake clock. */
export function shepherdFixture(options: FixtureOptions = {}): ShepherdFixture {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  let clock = 0;
  const tick = async (ms: number, signal: AbortSignal): Promise<void> => ((clock += ms), sleep(1, signal));
  const never = (_ms: number, signal: AbortSignal): Promise<void> => sleep(2 ** 31 - 1, signal);
  const routes = factoryRoutesFor({
    port: githubPort(fake.wire),
    store: shepherdStoreRef(),
    now: () => clock,
    sleep: options.frozen ? never : tick,
    ...(options.seats && { seats: () => options.seats! }),
  });
  return { fake, routes, workflows: [shepherdPrWorkflow(IDLE_PHASES), landPrWorkflow()] };
}

export async function callCommand<T>(host: FactoryHost, routes: FactoryRoutes, name: string, args: unknown): Promise<JsonEnvelope<T>> {
  const { envelope } = await invokeCommand(createFactoryRegistry().get(name)!, args, factoryContext(host, routes));
  return envelope as JsonEnvelope<T>;
}

export function shepherdRuns(host: FactoryHost): string[] {
  const every = host.runtime.list(["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"]);
  return every.filter((run) => run.workflowName === "shepherd-pr").map((run) => run.id);
}
