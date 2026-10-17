import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { partialFake } from "@titan-design/test-kit";
import type { WorkflowContext } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep, type LandOutcome } from "../workflows/land.js";
import { landPrWorkflow } from "../workflows/land-pr.js";
import { ownerSendBackWake } from "./owner-send-back.js";
import type { ShepherdPhases, VisualSetCarry, WakeOutcome, WakeRequest } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdStoreRef } from "./store.js";
import { askVisualAccept, type VisualAcceptRun } from "./visual-accept.js";

const H2 = fakeSha("head2");
const NOTE = "Commit these baselines from run 7 and nothing else.";
const SET = { fromHead: H1, files: [{ path: "packages/ui/__screenshots__/a.png" }] };
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface World {
  host: FactoryHost;
  fake: FakeGitHub;
  wakes: WakeRequest[];
  runId: string;
  steps: () => string[];
}

/** A shepherd-pr run on PR 1 whose head H1 is red on `failing`, in a repo whose seat names `visual` its baseline check. */
function world(mode: VisualSetCarry | undefined, failing: readonly string[] = ["visual"], unhandled = false): World {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, pr.headSha === H1 ? failing.map((name, i) => successRun(name, i + 1, undefined, "failure")) : [successRun("visual", 9)]);
  fake.addPr({ headSha: H1 });
  let clock = 0;
  const wakes: WakeRequest[] = [];
  const phases: ShepherdPhases = {
    review: async () => ({ kind: "none" }),
    wake: async (_ctx, request): Promise<WakeOutcome> => (wakes.push(request), unhandled ? { kind: "unhandled", reason: "no agent" } : (fake.pushHead(1, H2), { kind: "woken", agent: "impl-a" })),
    ...(mode && { visualSetCarry: () => mode }),
  };
  const seat = { name: "ui", remotes: [REPO.toLowerCase()], paths: {}, grants: [], visualPaths: ["packages/ui/**"], visualBaselines: { check: "visual", paths: ["**/__screenshots__/**"] } };
  const ref = shepherdStoreRef();
  const tick = async (ms: number, signal: AbortSignal) => ((clock += ms), sleep(1, signal));
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => clock, sleep: tick, seats: () => ({ seats: [seat], denied: [] }) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases), landPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  ref.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  const steps = () => Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
  return { host, fake, wakes, runId, steps };
}

const acceptGate = (w: World): string => gateId(w.runId, "sh-visual-accept");

describe("a head red only on its seat's baseline check", () => {
  it("asks the owner at that head before any fixer, and an accept wakes the review fix with the owner's note", async () => {
    const w = world("on");
    await gateOpened(w.host, acceptGate(w));
    const gate = w.host.gates.get(acceptGate(w))!;

    w.host.gates.resolve(gate.id, { decision: "accept-set", headSha: H1, approvedSet: SET, note: NOTE }, OWNER);
    await vi.waitFor(() => expect(w.wakes).toHaveLength(1));

    expect(gate.prompt).toBe(`Accept the regenerated baselines of PR #1 in ${REPO} at head ${H1}? CI is red only on visual.`);
    expect(gate.schema).toMatchObject({ properties: { headSha: { const: H1 } } });
    expect(w.wakes[0]).toMatchObject({ kind: "review", headSha: H1, payload: { kind: "OWNER_SEND_BACK", text: NOTE, visual: "accepted" } });
  });

  it("sends the owner's note back through the review wake, not the ci-red one", async () => {
    const w = world("shadow");
    await gateOpened(w.host, acceptGate(w));

    w.host.gates.resolve(acceptGate(w), { decision: "send-back", headSha: H1, note: NOTE }, OWNER);
    await vi.waitFor(() => expect(w.wakes).toHaveLength(1));

    expect(w.wakes[0]).toMatchObject({ kind: "review", payload: { text: NOTE, visual: "sent-back" } });
  });

  it("leaves an accept no agent took to the sent-back gate, with the owner's note", async () => {
    const w = world("on", ["visual"], true);
    await gateOpened(w.host, acceptGate(w));

    w.host.gates.resolve(acceptGate(w), { decision: "accept-set", headSha: H1, approvedSet: SET, note: NOTE }, OWNER);
    await gateOpened(w.host, gateId(w.runId, "sh-sent-back"));

    expect(w.host.gates.get(gateId(w.runId, "sh-sent-back"))?.prompt).toContain(NOTE);
  });

  it("stops the run on abandon, waking no one", async () => {
    const w = world("on");
    await gateOpened(w.host, acceptGate(w));

    w.host.gates.resolve(acceptGate(w), { decision: "abandon", headSha: H1 }, OWNER);
    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.status).toBe("completed"));

    expect(w.wakes).toEqual([]);
  });

  it("refuses an accept-set with no approved set or note, as gateNotify or a coordinator would send it", async () => {
    const w = world("on");
    await gateOpened(w.host, acceptGate(w));

    expect(() => w.host.gates.resolve(acceptGate(w), { decision: "accept-set", headSha: H1 }, OWNER)).toThrow();
    expect(w.host.gates.get(acceptGate(w))?.status).toBe("pending");
  });

  it("is not offered when another check is red too, and the ci-red wake goes out as today", async () => {
    const w = world("on", ["visual", "lint"]);
    await vi.waitFor(() => expect(w.wakes).toHaveLength(1));

    expect(w.wakes[0]?.kind).toBe("ci-red");
    expect(w.host.gates.get(acceptGate(w))).toBeUndefined();
  });

  it.each([["off" as const], [undefined]])("with the flag %s records no offer step and wakes ci-red as today", async (mode) => {
    const w = world(mode);
    await vi.waitFor(() => expect(w.wakes).toHaveLength(1));

    expect(w.wakes[0]?.kind).toBe("ci-red");
    expect(w.steps().filter((stepId) => stepId.startsWith("sh-visual-accept"))).toEqual([]);
  });
});

describe("the visual accept offer on replay", () => {
  const red: Extract<LandOutcome, { kind: "ci-failed" }> = { kind: "ci-failed", headSha: H1, failing: [{ name: "visual", conclusion: "failure", url: "", workflowRunId: 1 }] };
  const recorded = { offered: true, mode: "on", check: "visual" };
  const runWith = (next: string | undefined, resumed?: string) => {
    const dispatched: string[] = [];
    const asked: string[] = [];
    const dispatch: WorkflowContext["dispatch"] = async (stepId, _template, options) => {
      dispatched.push(stepId);
      return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: options?.schema?.parse({ result: recorded }) };
    };
    const assisted: WorkflowContext["assisted"] = async (stepId) => {
      asked.push(stepId);
      return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: { decision: "accept-set", headSha: H1, approvedSet: SET, note: NOTE } };
    };
    const ctx = partialFake<WorkflowContext>({ historyNext: () => next, resumedGate: () => resumed, dispatch, assisted, expireGates: () => [] });
    const run: VisualAcceptRun = { ctx, target: { repo: REPO, pr: 1 }, state: { waits: 0 }, visualAcceptOffers: 0 };
    return { run, dispatched, asked };
  };

  it.each([["off" as const], ["on" as const]])("replays a record from before the offer as it ran, with the flag %s now", async (mode) => {
    const { run, dispatched, asked } = runWith("sh-repair");
    const liveMode = vi.fn(() => mode);

    expect(await askVisualAccept(run, red, liveMode)).toEqual({ kind: "not-offered" });
    expect([dispatched, asked, liveMode.mock.calls]).toEqual([[], [], []]);
  });

  it("rebuilds the gate from the recorded offer after the flag was turned off, and keeps the accepted set", async () => {
    const { run, dispatched, asked } = runWith("sh-visual-accept-offer:0");
    const liveMode = vi.fn((): VisualSetCarry => "off");

    const accepted = await askVisualAccept(run, red, liveMode);

    expect(accepted).toMatchObject({ kind: "wake", payload: { visual: "accepted", text: NOTE } });
    expect([dispatched, asked, liveMode.mock.calls]).toEqual([["sh-visual-accept-offer:0"], ["sh-visual-accept"], []]);
    expect(run.acceptedSet?.fromHead).toBe(H1);
  });

  it("offers nothing to a live run resumed on another gate", async () => {
    const { run, dispatched } = runWith(undefined, "ci-failed");

    expect(await askVisualAccept(run, red, () => "on")).toEqual({ kind: "not-offered" });
    expect(dispatched).toEqual([]);
  });
});

describe("the fixer's wake after an accept", () => {
  it("tells the fixer to commit exactly the accepted files, the note fenced as data", () => {
    const wake = ownerSendBackWake(H1, { kind: "OWNER_SEND_BACK", text: NOTE, visual: "accepted" });

    expect(wake?.reason).toContain(`accepted the baselines CI regenerated at head ${H1}`);
    expect(wake?.reason).toContain("commit exactly the files it names and nothing else");
    expect(wake?.payload).toContain(`\`\`\`owner note\n${NOTE}\n\`\`\``);
  });
});
