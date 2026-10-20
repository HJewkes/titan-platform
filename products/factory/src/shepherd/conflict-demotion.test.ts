import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { GATE_DEMOTIONS } from "./auto-pass.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import type { ShepherdPhases, WakeRequest } from "./phases.js";
import type { EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef } from "./store.js";

const FIXER_HEADS = [fakeSha("conflict-implementer"), fakeSha("conflict-fresh")];
const AUTO: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: true, seat: "repo-seat" };
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface Sent {
  seat: string;
  text: string;
}

/** A dirty PR whose every fixer pushes a head that still conflicts; `wired` says whether a seat notice can go out. */
function conflictWorld(wired = true) {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.addPr({ headSha: H1, mergeableState: "dirty" });
  const wakes: WakeRequest[] = [];
  const phases: ShepherdPhases = {
    wake: async (_ctx, request) => (wakes.push(request), fake.pushHead(1, FIXER_HEADS[wakes.length - 1] ?? fakeSha(`conflict-${wakes.length}`)), { kind: "woken", agent: `fixer-${wakes.length}` }),
    review: async () => ({ kind: "none", cause: "no-verdict" }),
  };
  const sent: Sent[] = [];
  const ports: ExitNoticePorts = { seatFor: () => "repo-seat", hubSeat: () => "hub-seat", lastReport: async () => undefined, send: async (seat, text) => void sent.push({ seat, text }) };
  const store = shepherdStoreRef();
  let clock = 0;
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), ...(wired && { exitNotice: ports }), park: async () => ({ lines: [] }) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO });
  return { fake, host, runId, wakes, sent };
}

const approveMergeSteps = ({ host, runId }: ReturnType<typeof conflictWorld>): string[] => Object.keys(host.runtime.status(runId)!.stepResults).filter((id) => id.startsWith("approve-merge"));

describe("D9: a conflict that survives one fixer (TP-3734)", () => {
  it("wakes a second, fresh fixer, then tells the seat and waits for a new head, with no approve-merge", async () => {
    const world = conflictWorld();

    await vi.waitFor(() => expect(world.host.runtime.status(world.runId)?.currentStep).toMatch(/^await-new-head/));

    expect(world.wakes.map((wake) => [wake.kind, wake.headSha, wake.payload])).toEqual([
      ["conflict", H1, { mergeableState: "dirty" }],
      ["conflict", FIXER_HEADS[0], { mergeableState: "dirty", freshFixer: true }],
    ]);
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]!.seat).toBe("repo-seat");
    expect(world.sent[0]!.text).toContain(`at head ${FIXER_HEADS[1]}`);
    expect(world.sent[0]!.text).toContain("the fresh fixer's head still conflicts with its base");
    expect(world.host.gates.listPending()).toEqual([]);
    expect(approveMergeSteps(world)).toEqual([]);
    expect(world.fake.effects.merge).toBe(0);
  });

  it("opens the owner's conflict gate only when no seat notice could go out, naming why", async () => {
    const world = conflictWorld(false);

    await gateOpened(world.host, gateId(world.runId, "approve-merge"));

    expect(world.wakes).toHaveLength(2);
    expect(world.host.gates.get(gateId(world.runId, "approve-merge"))?.prompt).toContain("(no seat notice is wired)");
  });

  it("opens the owner's conflict gate after one fixer, as before, with the demotion reverted", async () => {
    GATE_DEMOTIONS.conflict = false;
    hosts.push(partialFake<FactoryHost>({ close: () => void (GATE_DEMOTIONS.conflict = true) }));
    const world = conflictWorld();

    await gateOpened(world.host, gateId(world.runId, "approve-merge"));

    expect(world.wakes).toHaveLength(1);
    expect(world.sent).toEqual([]);
  });
});
