import { fakeGitHub, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import type { HeldWake } from "./held-wake.js";
import { heldVerdictMarker, postHeldVerdict } from "./held-verdict.js";
import type { ShepherdPhases, Verdict, WakeOutcome } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef } from "./store.js";

const FINDINGS = "1. The retry loop never ends when the broker answers 429.";
const FIX_FIRST_TEXT = `${FINDINGS}\n\nVerdict: FIX_FIRST\nPR: ${REPO}#1\nHead: ${H1}\n`;
const REFUSAL = "agent-chat refused to start the successor impl-a-s1: DispatchError";
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function seat(): { sends: { seat: string; text: string }[]; ports: ExitNoticePorts } {
  const sends: { seat: string; text: string }[] = [];
  const ports: ExitNoticePorts = { seatFor: () => "demo-coord", lastReport: async () => undefined, send: async (name, text) => void sends.push({ seat: name, text }) };
  return { sends, ports };
}

const review = async (_ctx: unknown, request: { headSha: string }): Promise<Verdict> => (request.headSha === H1 ? { kind: "FIX_FIRST", headSha: H1, text: FIX_FIRST_TEXT } : { kind: "none" });

function run(fake: FakeGitHub, ports: ExitNoticePorts, wake: ShepherdPhases["wake"]): { host: FactoryHost; runId: string } {
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  let clock = 0;
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), exitNotice: ports });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review, wake })], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1 });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return { host, runId };
}

const heldComments = (fake: FakeGitHub) => (fake.comments.get(1) ?? []).filter((comment) => comment.body.includes(heldVerdictMarker(H1)));

describe("a FIX_FIRST whose fixer agent-chat refused to start", () => {
  it("posts one PR comment with the findings and tells the seat the findings too", async () => {
    const fake = fakeGitHub();
    const { sends, ports } = seat();
    const held: HeldWake = { kind: "unhandled", reason: REFUSAL, held: { agent: "impl-a-s1" } };
    const { host, runId } = run(fake, ports, async () => held);

    await vi.waitFor(() => expect(host.runtime.status(runId)?.currentStep).toMatch(/^await-new-head/));

    const comments = heldComments(fake);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain(FINDINGS);
    expect(comments[0]!.body).not.toContain("Verdict: FIX_FIRST");
    expect(comments[0]!.body).not.toContain("impl-a-s1");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).toContain(REFUSAL);
    expect(sends[0]!.text).toContain(FINDINGS);
  });
});

describe("a FIX_FIRST whose fixer starts", () => {
  it("posts no findings comment and sends no seat notice", async () => {
    const fake = fakeGitHub();
    const { sends, ports } = seat();
    const woken = async (): Promise<WakeOutcome> => (fake.pushHead(1, "f".repeat(40)), { kind: "woken", agent: "impl-a" });
    const { host, runId } = run(fake, ports, woken);

    await gateOpened(host, gateId(runId, "approve-merge"));

    expect(heldComments(fake)).toEqual([]);
    expect(sends).toEqual([]);
  });
});

describe("a second refusal at the same FIX_FIRST", () => {
  it("finds the first comment and posts no duplicate", async () => {
    const fake = fakeGitHub();
    fake.addPr({ headSha: H1 });
    const port = githubPort(fake.wire);
    const input = { repo: REPO, pr: 1, headSha: H1, findings: FINDINGS };

    const first = await postHeldVerdict(port, input);
    const second = await postHeldVerdict(port, input);

    expect(first.posted).toBe(true);
    expect(second.posted).toBe(false);
    expect(heldComments(fake)).toHaveLength(1);
  });
});
