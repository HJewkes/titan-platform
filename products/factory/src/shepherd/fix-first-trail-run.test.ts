import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ShepherdPhases, Verdict, WakeRequest } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdStoreRef } from "./store.js";
import { describeWake } from "./wake-brief.js";
import { FixFirstEntrySchema } from "./fix-first-trail.js";

/** Synthetic heads: FIX_FIRST at A, the fixer's push to B, FIX_FIRST at B, the fixer's push to C, MERGE at C. */
const A = fakeSha("trail-run-a");
const B = fakeSha("trail-run-b");
const C = fakeSha("trail-run-c");
const NEXT: Record<string, string> = { [A]: B, [B]: C };
const A_ITEM = "1. The guard reads $1 unquoted, so a spaced path splits.";
const textAt = (head: string, item: string) => `${item}\n\nDefect class: unquoted shell words.\n\nVerdict: FIX_FIRST\nPR: ${REPO}#1\nHead: ${head}`;
const fixFirstAt = (headSha: string, item: string): Verdict => ({ kind: "FIX_FIRST", headSha, text: textAt(headSha, item) });

const SCRATCH = mkdtempSync(join(tmpdir(), "tp2394-trail-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A host over `dbPath` whose reviewer answers each head as `reviewAt` says and whose fixer pushes the next head once. */
function openHost(fake: FakeGitHub, dbPath: string, reviewAt: (head: string) => Promise<Verdict>) {
  const wakes: WakeRequest[] = [];
  const phases: ShepherdPhases = {
    review: async (_ctx, request) => reviewAt(request.headSha),
    wake: async (_ctx, request) => {
      wakes.push(request);
      if (fake.pr(1).headSha === request.headSha) fake.pushHead(1, NEXT[request.headSha]!);
      return { kind: "woken", agent: "impl-a" };
    },
  };
  fake.onGetPr = (open) => fake.setRuns(open.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
  const host = openFactoryHost({ dbPath, workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, store, wakes };
}

const earlierOf = (request: WakeRequest | undefined) => z.looseObject({ earlier: z.array(FixFirstEntrySchema).optional() }).parse(request?.payload).earlier;

describe("a run restarted between its first and second FIX_FIRST", () => {
  it("hands the second fix round the first round's findings and class exactly once", async () => {
    const dbPath = join(SCRATCH, "factory.db");
    const fake = fakeGitHub();
    fake.addPr({ headSha: A });
    const first = openHost(fake, dbPath, (head) => (head === A ? Promise.resolve(fixFirstAt(A, A_ITEM)) : new Promise<Verdict>(() => undefined)));
    const runId = first.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
    first.store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    await vi.waitFor(() => expect(fake.pr(1).headSha).toBe(B));
    first.host.close();

    const second = openHost(fake, dbPath, async (head) => (head === C ? { kind: "MERGE", headSha: C, evidence: {} } : fixFirstAt(head, head === A ? A_ITEM : "1. The hook reads $@ unquoted.")));
    await second.host.resume();
    await gateOpened(second.host, gateId(runId, "approve-merge"));

    const atB = second.wakes.find((request) => request.headSha === B);
    expect(earlierOf(first.wakes[0])).toBeUndefined();
    expect(earlierOf(atB)).toEqual([expect.objectContaining({ headSha: A, text: textAt(A, A_ITEM), defectClass: "Defect class: unquoted shell words." })]);
    const brief = await describeWake(githubPort(fake.wire), { kind: "review", repo: REPO, pr: 1, headSha: B, payload: atB!.payload, fixFirst: 2 }, fake.pr(1));
    expect(brief.payload.split(A_ITEM)).toHaveLength(2);
    expect(brief.reason).toContain("Add one table-driven test over every form the class can take");
  });
});
