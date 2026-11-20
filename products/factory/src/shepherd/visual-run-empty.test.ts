import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, githubPort, successRun, type CheckRun } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ShepherdPhases } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { EffectivePolicy } from "./policy-schema.js";
import { shepherdPrWorkflow } from "./pr.js";
import type { ExitNoticePorts } from "./ports.js";
import type { PrVisualFrames, VisualPacketPorts } from "./spawn-ports.js";
import { shepherdStoreRef } from "./store.js";
import { visualPacket } from "./visual-packet-trigger.js";
import { makePacketDir } from "./visual-packet-trigger-adapter.js";

const VISUAL: EffectivePolicy = { ...OWNER_GATE_POLICY, ownerGateReason: "gate-2-visual", seat: "design-seat" };
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const prVisualRun = (conclusion: string): CheckRun => successRun("pr-visual", 7, undefined, conclusion, undefined, H1);

interface Options {
  conclusion: string;
  frames: number | string;
  seatSends?: boolean;
}

/**
 * A gate-2-visual registration, reviewed MERGE at a green head. Any failed run reads red to CI, so the pr-visual run
 * concludes only once the review is done, as a long capture job does after the required checks went green.
 */
function visualRun({ conclusion, frames, seatSends = true }: Options) {
  const fake = fakeGitHub();
  let concluded = false;
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2), ...(concluded ? [prVisualRun(conclusion)] : [])]);
  const reviewed: ShepherdPhases = {
    wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
    review: async (_ctx, request) => {
      concluded = true;
      fake.setRuns(request.headSha, [successRun("validate", 1), successRun("dag-check", 2), prVisualRun(conclusion)]);
      return { kind: "MERGE", headSha: request.headSha, evidence: {} };
    },
  };
  fake.addPr({ headSha: H1 });
  const sends: { seat: string; text: string }[] = [];
  const exitNotice: ExitNoticePorts = { seatFor: () => "design-seat", lastReport: async () => undefined, send: async (seat, text) => void sends.push({ seat, text }) };
  const frameReads: string[] = [];
  const prVisualFrames: PrVisualFrames = async (_repo, head) => (frameReads.push(head), frames);
  const store = shepherdStoreRef();
  let clock = 0;
  const tick = async (ms: number, signal: AbortSignal) => ((clock += ms), sleep(1, signal));
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: tick, park: async () => ({ lines: [] }), prVisualFrames, ...(seatSends && { exitNotice }) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(reviewed)], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: VISUAL });
  return { host, runId, sends, frameReads };
}

const Recorded = z.object({ result: z.record(z.string(), z.unknown()) });

function stepsNamed(host: FactoryHost, runId: string, prefix: string): Record<string, unknown>[] {
  return Object.entries(host.runtime.status(runId)!.stepResults)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, step]) => Recorded.parse(step.data).result);
}

/** The seat was told; the run then waits on a new head (the wait step records only once one arrives), with no gate open. */
async function seatTold(host: FactoryHost, runId: string): Promise<void> {
  await vi.waitFor(() => expect(stepsNamed(host, runId, "sh-seat-notice")).toHaveLength(1));
  expect(host.runtime.status(runId)?.status).toBe("running");
}

describe("a visual gate whose pr-visual run had nothing to show (TP-6776)", () => {
  it("a failed run tells the seat, records why on the timeline, and opens no owner gate", async () => {
    const { host, runId, sends, frameReads } = visualRun({ conclusion: "failure", frames: 3 });

    await seatTold(host, runId);

    expect(host.pendingGates().filter((gate) => gate.runId === runId)).toEqual([]);
    expect(stepsNamed(host, runId, "sh-visual-packet:")).toEqual([expect.objectContaining({ event: "visual-run-empty", reason: "the pr-visual run concluded failure", prVisualConclusion: "failure" })]);
    expect(stepsNamed(host, runId, "sh-seat-notice")).toEqual([expect.objectContaining({ sent: true, gate: "visual-empty", headSha: H1 })]);
    expect(sends).toEqual([{ seat: "design-seat", text: expect.stringContaining("the pr-visual run concluded failure, so the visual gate has nothing for the owner to look at") }]);
    expect(frameReads).toEqual([]);
  });

  it("a successful run that rendered zero frames goes to the seat the same way", async () => {
    const { host, runId, sends } = visualRun({ conclusion: "success", frames: 0 });

    await seatTold(host, runId);

    expect(host.pendingGates().filter((gate) => gate.runId === runId)).toEqual([]);
    expect(stepsNamed(host, runId, "sh-visual-packet:")).toEqual([expect.objectContaining({ event: "visual-run-empty", reason: "the pr-visual run succeeded with zero frames rendered", frames: 0 })]);
    expect(sends).toHaveLength(1);
  });

  it("an empty run whose seat notice cannot go out opens the owner gate, saying why", async () => {
    const { host, runId } = visualRun({ conclusion: "failure", frames: 0, seatSends: false });
    const gate = gateId(runId, "approve-merge");

    await gateOpened(host, gate);

    expect(host.gates.get(gate)?.prompt).toContain("Nothing to look at: the pr-visual run concluded failure");
  });
});

describe("a visual gate with frames to look at", () => {
  it.each([
    ["rendered frames", 4],
    ["an unread frame count", "the frame read failed: synthetic"],
  ])("a successful run with %s opens the owner gate as before and tells no seat", async (_case, frames) => {
    const { host, runId, sends, frameReads } = visualRun({ conclusion: "success", frames });
    const gate = gateId(runId, "approve-merge");

    await gateOpened(host, gate);

    expect(host.gates.get(gate)?.prompt).not.toContain("Nothing to look at");
    expect(frameReads).toEqual([H1]);
    expect(sends).toEqual([]);
    expect(stepsNamed(host, runId, "sh-visual-packet:")).toEqual([{ event: "visual-packet-off" }]);
  });
});

describe("the packet step at a failed pr-visual run, by the gate it precedes", () => {
  const shadow: VisualPacketPorts = { mode: "shadow", profile: "review-packager", stateDir: mkdtempSync(join(tmpdir(), "visual-empty-")), cwdFor: () => tmpdir(), titanReviewBin: "/opt/synthetic/bin/titan-review", makeDir: makePacketDir };
  const failedRun = () => {
    const fake = fakeGitHub();
    fake.setRuns(H1, [prVisualRun("failure")]);
    return githubPort(fake.wire);
  };
  const packetBefore = (gateStep: string) => visualPacket(failedRun(), shadow, { runId: "run-synthetic-1", repo: REPO, pr: 1, headSha: H1, gateId: `run-synthetic-1/${gateStep}` });

  it("the owner's ask to accept regenerated baselines still gets a packager for that run", async () => {
    const results = [await packetBefore("sh-visual-accept"), await packetBefore("sh-visual-accept:1")];

    expect(results).toEqual([0, 1].map(() => expect.objectContaining({ event: "visual-packet-would-spawn", ciRunId: 1007, prVisualConclusion: "failure" })));
  });

  it("an approve-merge gate finds the run empty and gets no packager", async () => {
    const results = [await packetBefore("approve-merge"), await packetBefore("approve-merge:2")];

    expect(results).toEqual([0, 1].map(() => expect.objectContaining({ event: "visual-run-empty", reason: "the pr-visual run concluded failure" })));
  });
});
