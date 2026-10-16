import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { landPrWorkflow } from "../workflows/land-pr.js";
import { partialFake } from "@titan-design/test-kit";
import type { WorkflowContext } from "@titan-design/workflow";
import { sendBackOffer } from "./owner-send-back.js";
import type { ShepherdPhases, WakeOutcome, WakeRequest } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";
import { watchRow } from "./view.js";
import { waitingGates } from "./waiting.js";

const H2 = fakeSha("head2");
const NOTE = "Rename the flag before this lands.";
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface World {
  host: FactoryHost;
  fake: FakeGitHub;
  store: ShepherdStore;
  wakes: WakeRequest[];
  runId: string;
  /** Lets the woken implementer push H2; until then the run sits in its review wake. */
  push: () => void;
}

/** A shepherd-pr run on PR 1 at H1 under the owner gate policy, with `shepherd.consoleAnswers` set or not. */
function world(consoleAnswers: boolean): World {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.addPr({ headSha: H1 });
  let clock = 0;
  let push = (): void => undefined;
  const pushed = new Promise<void>((resolve) => (push = resolve));
  const wakes: WakeRequest[] = [];
  const phases: ShepherdPhases = {
    review: async () => ({ kind: "none" }),
    wake: async (_ctx, request): Promise<WakeOutcome> => (wakes.push(request), await pushed, fake.pushHead(1, H2), { kind: "woken", agent: "impl-a" }),
  };
  const ref = shepherdStoreRef();
  const tick = async (ms: number, signal: AbortSignal) => ((clock += ms), sleep(1, signal));
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => clock, sleep: tick, consoleAnswers });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases), landPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  ref.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return { host, fake, store: ref.get(), wakes, runId, push };
}

const offered = (w: World, gate: string): unknown => w.host.gates.get(gate)?.questions?.[0]?.options.map((option) => option.id);
const row = (w: World) => watchRow({ registration: w.store.byRun(w.runId)!, run: w.host.runtime.status(w.runId)! });

describe("an owner send-back at approve-merge", () => {
  it("wakes the implementer's review fix with the owner's note, then asks again at the new head without merging the old one", async () => {
    const w = world(true);
    const first = gateId(w.runId, "approve-merge");
    await gateOpened(w.host, first);

    w.host.gates.resolve(first, { decision: "send-back", headSha: H1, note: NOTE }, OWNER);
    await vi.waitFor(() => expect(w.wakes).toHaveLength(1));
    const fixing = row(w);
    w.push();
    await gateOpened(w.host, gateId(w.runId, "approve-merge", 1));

    expect(offered(w, first)).toEqual(["merge", "abandon", "send-back"]);
    expect(w.wakes).toEqual([{ kind: "review", repo: REPO, pr: 1, round: 0, headSha: H1, payload: { kind: "OWNER_SEND_BACK", text: NOTE } }]);
    expect(w.fake.effects.merge).toBe(0);
    expect(w.host.gates.get(gateId(w.runId, "approve-merge", 1))?.prompt).toContain(`at head ${H2}`);
    expect(fixing).toMatchObject({ phase: "fixing", pendingGate: null });
    expect(waitingGates([fixing])).toEqual({ owner: [], seat: [] });
  });

  it("is not offered while shepherd.consoleAnswers is unset", async () => {
    const w = world(false);
    const gate = gateId(w.runId, "approve-merge");
    await gateOpened(w.host, gate);

    expect(offered(w, gate)).toEqual(["merge", "abandon"]);
    expect(Object.values(w.host.runtime.status(w.runId)!.stepResults).find((result) => result.stepId.startsWith("sh-send-back-offer"))?.data).toMatchObject({ result: { offered: false } });
  });
});

describe("the send-back offer step", () => {
  const ctxWith = (next: string | undefined) => {
    const dispatched: string[] = [];
    const result = (stepId: string) => ({ stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: { result: { offered: true } } });
    const dispatch = async (stepId: string) => (dispatched.push(stepId), result(stepId));
    return { ctx: partialFake<WorkflowContext>({ historyNext: () => next, dispatch: dispatch as WorkflowContext["dispatch"] }), dispatched };
  };

  it("replays a record from before the step as no offer, dispatching nothing", async () => {
    const { ctx, dispatched } = ctxWith("approve-merge");

    expect(await sendBackOffer()(ctx)).toBe(false);
    expect(dispatched).toEqual([]);
  });

  it("reads the flag once per gate, each under its own step id", async () => {
    const { ctx, dispatched } = ctxWith(undefined);
    const offer = sendBackOffer();

    expect([await offer(ctx), await offer(ctx)]).toEqual([true, true]);
    expect(dispatched).toEqual(["sh-send-back-offer:0", "sh-send-back-offer:1"]);
  });
});
