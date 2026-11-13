import { fakeGitHub, githubPort } from "@titan-design/github";
import { partialFake } from "@titan-design/test-kit";
import { StepFailedError, type RoutedStepInput, type StepRoute, type StepRunOutcome, type WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { auditRoutes } from "../audit/routes.js";
import { buildSurfaceRoutes } from "../build-surface/routes.js";
import type { BuildSurfacePorts } from "../build-surface/ports.js";
import type { AuditPorts } from "../audit/ports.js";
import { factoryRoutesFor } from "../workflows.js";
import { FAILURE_CLASSES, classifyingFailures } from "./failure-class.js";
import { shepherdStoreRef } from "./store.js";

/** Not Shepherd's: the audit and build-surface workflows share the host's route list but never run in a Shepherd run. */
function foreignMatches(): Set<string> {
  const foreign = [...auditRoutes(partialFake<AuditPorts>()), ...buildSurfaceRoutes(partialFake<BuildSurfacePorts>({ now: () => 0 }))];
  return new Set(foreign.map((route) => route.match));
}

function shepherdCodeRoutes(): StepRoute[] {
  const routes = factoryRoutesFor({ port: githubPort(fakeGitHub().wire), store: shepherdStoreRef(), now: () => 0, sleep: async () => undefined, registry: async () => "trusted" as const });
  const foreign = foreignMatches();
  return routes.filter((route) => route.onRestart === "repeat" && !foreign.has(route.match));
}

/** A prompt no body can parse, so every code route fails in its own body, where it records the class. */
function failOnce(route: StepRoute): Promise<StepRunOutcome> {
  const input: RoutedStepInput = { runId: "r", workflowName: "shepherd-pr", stepId: `${route.match}:0`, iteration: 0, prompt: "not json", signal: AbortSignal.timeout(5_000), attempt: 0, requestKey: "k" };
  return route.runner.run(input);
}

describe("every failure site sets the class", () => {
  it("records a known class on every failed outcome of a repeat-safe Shepherd step", async () => {
    const routes = shepherdCodeRoutes();

    const settled = await Promise.allSettled(routes.map(async (route) => [route.match, await failOnce(route)] as const));

    const outcomes = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    expect(outcomes.length).toBeGreaterThan(20);
    const unclassed = outcomes.filter(([, outcome]) => outcome.ok || !FAILURE_CLASSES.some((known) => known === outcome.errorClass)).map(([match]) => match);
    expect(unclassed).toEqual([]);
  });

  it("classes a step whose wrapper rejected before its body by the step's id, so the run still records one", async () => {
    const routes = shepherdCodeRoutes();

    const settled = await Promise.allSettled(routes.map((route) => failOnce(route).then(() => undefined, () => route.match)));

    const rejectedBeforeBody = settled.flatMap((result) => (result.status === "fulfilled" && result.value !== undefined ? [result.value] : []));
    const classes = await Promise.all(rejectedBeforeBody.map((match) => runClassOf(new StepFailedError(`${match}:0`, 0, "not json"))));
    expect(classes.every((known) => FAILURE_CLASSES.some((name) => name === known))).toBe(true);
  });
});

async function runClassOf(error: StepFailedError): Promise<unknown> {
  const caught: unknown = await classifyingFailures(() => Promise.reject(error))(partialFake<WorkflowContext>()).catch((thrown: unknown) => thrown);
  return typeof caught === "object" && caught !== null && "errorClass" in caught ? caught.errorClass : undefined;
}
