import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { GATE_DEMOTIONS } from "./auto-pass.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import type { ShepherdPhases, WakeOutcome, WakeRequest } from "./phases.js";
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

const BASES = [fakeSha("base-1"), fakeSha("base-2")];

/** What one fixer wake does to the fake beyond pushing its head; returning a result replaces the default `woken`. */
type OnWake = (fake: FakeGitHub, wake: number, head: string) => WakeOutcome | void;

/** A dirty PR whose every fixer pushes a head that still conflicts; `wired` says whether a seat notice can go out. */
function conflictWorld(wired = true, onWake: OnWake = () => undefined) {
  const fake = fakeGitHub({ baseSha: BASES[0] });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.addPr({ headSha: H1, mergeableState: "dirty" });
  const wakes: WakeRequest[] = [];
  const phases: ShepherdPhases = {
    wake: async (_ctx, request) => {
      wakes.push(request);
      const head = FIXER_HEADS[wakes.length - 1] ?? fakeSha(`conflict-${wakes.length}`);
      fake.pushHead(1, head);
      return onWake(fake, wakes.length, head) ?? { kind: "woken", agent: `fixer-${wakes.length}` };
    },
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

const stepsOf = ({ host, runId }: ReturnType<typeof conflictWorld>, family: string): string[] => Object.keys(host.runtime.status(runId)!.stepResults).filter((id) => id.startsWith(family));
const approveMergeSteps = (world: ReturnType<typeof conflictWorld>): string[] => stepsOf(world, "approve-merge");

/** The implementer's head merges the base it was woken at; `moveTo` then moves main past it. */
const mergesBase = (moveTo?: string): OnWake => (fake, wake, head) => {
  if (wake > 1) return;
  fake.commits.set(head, { sha: head, parents: [H1, BASES[0]!] });
  if (moveTo) fake.refs.set("main", moveTo);
};
const END: WakeOutcome = { kind: "unhandled", reason: "the scenario ends at the second wake" };
const wakePayloads = (world: ReturnType<typeof conflictWorld>) => world.wakes.map((wake) => [wake.headSha, wake.payload]);

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

describe("TP-4098 slice A: a conflict at a new base is a new conflict", () => {
  it("wakes the implementer again, telling no seat, when main moved past the fixer's merge-main", async () => {
    const world = conflictWorld(true, (fake, wake, head) => (wake > 1 ? END : mergesBase(BASES[1])(fake, wake, head)));

    await vi.waitFor(() => expect(world.host.runtime.status(world.runId)?.status).not.toBe("running"));

    expect(wakePayloads(world)).toEqual([
      [H1, { mergeableState: "dirty" }],
      [FIXER_HEADS[0], { mergeableState: "dirty" }],
    ]);
    expect(stepsOf(world, "sh-seat-notice")).toEqual([]);
    expect(approveMergeSteps(world)).toEqual([]);
  });

  it("still wakes a fresh fixer, then tells the seat, when the conflict survives at the same base", async () => {
    const world = conflictWorld(true, mergesBase());

    await vi.waitFor(() => expect(world.host.runtime.status(world.runId)?.currentStep).toMatch(/^await-new-head/));

    expect(wakePayloads(world)).toEqual([
      [H1, { mergeableState: "dirty" }],
      [FIXER_HEADS[0], { mergeableState: "dirty", freshFixer: true }],
    ]);
    expect(world.sent).toHaveLength(1);
  });

  it("demotes as before when main moved but the fixer's head never merged the last base", async () => {
    const world = conflictWorld(true, (fake, wake) => void (wake === 1 && fake.refs.set("main", BASES[1]!)));

    await vi.waitFor(() => expect(world.host.runtime.status(world.runId)?.currentStep).toMatch(/^await-new-head/));

    expect(world.wakes[1]?.payload).toEqual({ mergeableState: "dirty", freshFixer: true });
    expect(world.sent).toHaveLength(1);
  });

  it("counts an unreadable base as the same base", async () => {
    const world = conflictWorld(true, (fake, wake, head) => {
      mergesBase(BASES[1])(fake, wake, head);
      fake.readFaults.compareAncestry = [new Error("HTTP 502")];
    });

    await vi.waitFor(() => expect(world.host.runtime.status(world.runId)?.currentStep).toMatch(/^await-new-head/));

    expect(world.wakes[1]?.payload).toEqual({ mergeableState: "dirty", freshFixer: true });
    expect(world.sent).toHaveLength(1);
  });
});
