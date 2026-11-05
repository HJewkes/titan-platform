import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { deadEndParam, deadEndRoutes, deadEndWorkflow } from "../test-support/dead-end.js";
import { H1, REPO, gateId, gateOpened, outsideActions } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { CHECKS_RECHECK_MS } from "../workflows/await-head.js";
import { codeRoute, sleep } from "../workflows/land.js";
import type { ShepherdPhases, Verdict, WakeOutcome } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef } from "./store.js";
import type { ExitNoticePorts } from "./ports.js";

const H2 = fakeSha("head2");
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const exited: WakeOutcome = { kind: "unhandled", exited: true, reason: `impl-a exited without pushing a new head past ${H1}`, wake: { agent: "impl-a", mode: "resume" } };

/** The seat book cannot be told, so every no-push exit takes the owner's sent-back gate. */
const unsentSeat: ExitNoticePorts = { seatFor: () => "demo-coord", lastReport: async () => undefined, send: async () => Promise.reject(new Error("broker refused the message")) };

interface World {
  host: FactoryHost;
  runId: string;
  clock: { now: number };
}

/** The fixer takes each wake and exits at H1 with no push, as tc-tp-2080-c did on tp#1188 run c94ab3dc. */
function world(fake: FakeGitHub, review: ShepherdPhases["review"] = async () => ({ kind: "none" })): World {
  const phases: ShepherdPhases = { wake: async () => exited, review };
  const clock = { now: 0 };
  const tick = async (ms: number, signal: AbortSignal) => ((clock.now += ms), sleep(1, signal));
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock.now, sleep: tick, exitNotice: unsentSeat });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1 });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return { host, runId, clock };
}

/** validate is red at H1 until `state.fixed`, as hub-compose was until attempt 2 at 04:26. */
function redUntilFixed(fake: FakeGitHub, state: { fixed: boolean }): void {
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [outsideActions(successRun("validate", 1, undefined, pr.headSha === H1 && !state.fixed ? "failure" : "success")), successRun("dag-check", 2)]);
}

function result(host: FactoryHost, runId: string, stepId: string): unknown {
  return Object.values(host.runtime.status(runId)!.stepResults).find((step) => step.stepId === stepId)?.data;
}

async function awaitAfterSentBack({ host, runId }: World): Promise<void> {
  await gateOpened(host, gateId(runId, "sh-sent-back"));
  host.runtime.signal(runId, "sh-sent-back", { decision: "await-new-head" }, OWNER);
  await vi.waitFor(() => expect(host.runtime.status(runId)?.currentStep).toMatch(/^await-new-head/));
}

describe("the wait after a fixer exits with no push, when the same head turns green", () => {
  it("replays tp#1188 c94ab3dc: after a ci-red exit's sent-back gate, a rerun turning H1 green re-enters the round at H1 with no new commit", async () => {
    const fake = fakeGitHub();
    const state = { fixed: false };
    redUntilFixed(fake, state);
    const w = world(fake);
    await awaitAfterSentBack(w);

    state.fixed = true;
    await gateOpened(w.host, gateId(w.runId, "approve-merge"), 5_000);
    w.host.runtime.signal(w.runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
    await w.host.runtime.wait(w.runId);

    expect(result(w.host, w.runId, "await-new-head:0")).toMatchObject({ result: { headSha: H1, green: true } });
    expect(fake.effects.merge).toBe(1);
    expect(fake.pr(1).headSha).toBe(H1);
  });

  it("a review-kind (FIX_FIRST) exit still waits for a new head while every check at H1 is green", async () => {
    const fake = fakeGitHub();
    redUntilFixed(fake, { fixed: true });
    const review = async (_ctx: unknown, request: { headSha: string }): Promise<Verdict> => (request.headSha === H1 ? { kind: "FIX_FIRST", headSha: H1, text: "missing test" } : { kind: "none" });
    const w = world(fake, review);
    await awaitAfterSentBack(w);

    const from = w.clock.now;
    await vi.waitFor(() => expect(w.clock.now - from).toBeGreaterThan(3 * CHECKS_RECHECK_MS));
    expect(result(w.host, w.runId, "await-new-head:0")).toBeUndefined();

    fake.pushHead(1, H2);
    await gateOpened(w.host, gateId(w.runId, "approve-merge"));
    expect(result(w.host, w.runId, "await-new-head:0")).toMatchObject({ result: { headSha: H2 } });
  });
});

describe("the seat's dead-end gate after a ci-red exit", () => {
  /** Echoes each await-new-head input, so the test reads what the wait was asked to end on. */
  function echoAwait(inputs: object[]): StepRoute {
    return codeRoute("await-new-head", () => 0, async (input: { headSha: string }) => (inputs.push(input), { headSha: `${input.headSha.slice(0, 39)}f`, state: "open" }));
  }

  it("a respawn's wait also ends on the same head turning green, and carries the red checks", async () => {
    const inputs: object[] = [];
    const routes = [...deadEndRoutes().filter((route) => route.match !== "await-new-head"), echoAwait(inputs)];
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [deadEndWorkflow], routes, gatePollMs: 5 });
    hosts.push(host);
    const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", deadEnd: deadEndParam([H1], "exited-without-push", false, { failing: [{ name: "validate" }] }) });

    await gateOpened(host, gateId(runId, "sh-dead-end"));
    host.gates.resolve(gateId(runId, "sh-dead-end"), { decision: "respawn", headSha: H1 }, OWNER);
    await vi.waitFor(() => expect(inputs).toHaveLength(1));

    expect(inputs[0]).toMatchObject({ headSha: H1, untilGreen: true, failing: ["validate"] });
  });

  it("a respawn after an exit at any other wake waits for a new head only", async () => {
    const inputs: object[] = [];
    const routes = [...deadEndRoutes().filter((route) => route.match !== "await-new-head"), echoAwait(inputs)];
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [deadEndWorkflow], routes, gatePollMs: 5 });
    hosts.push(host);
    const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", deadEnd: deadEndParam([H1]) });

    await gateOpened(host, gateId(runId, "sh-dead-end"));
    host.gates.resolve(gateId(runId, "sh-dead-end"), { decision: "respawn", headSha: H1 }, OWNER);
    await vi.waitFor(() => expect(inputs).toHaveLength(1));

    expect(inputs[0]).not.toHaveProperty("untilGreen");
  });
});
