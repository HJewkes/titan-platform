import { fakeGitHub, githubPort } from "@titan-design/github";
import { partialFake } from "@titan-design/test-kit";
import { WorkflowRunStore } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import type { FactoryContext } from "../registry.js";
import { factoryRoutesFor } from "../workflows.js";
import { SHEPHERD_COMMAND_MAP } from "./commands.js";
import { MergeOrder, type MergeOrderRules } from "./merge-order.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdStoreRef } from "./store.js";

const REPO = "demo/repo";
const SHARED = "docs/shared.md";
const AT = Date.parse("2026-10-23T10:00:00.000Z");
const minutes = (n: number): string => new Date(AT + n * 60_000).toISOString();
const RULES: MergeOrderRules = () => ({ enabled: true, ttlMinutes: 120, ignore: [] });
const WAIT = `merge order: waiting behind #101 (${SHARED})`;
const NAMED = `${WAIT}; #101 reserved since ${minutes(0)}, its run in fixing`;

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A (#101) holds a reservation while its fixer works; B (#103) sits in its order-wait step behind it, past the merging limit. */
function parkedWorld() {
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fakeGitHub().wire), store, now: () => AT + 30 * 60_000, mergeOrderRules: RULES });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [], routes });
  hosts.push(host);
  const runs = new WorkflowRunStore(host.db);
  const at = (runId: string, pr: number, step: string): void => {
    runs.create({ id: runId, workflowName: "shepherd-pr", params: { repo: REPO, pr: String(pr) }, status: "running", currentStep: step, stepResults: {}, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: minutes(0), completedAt: null, error: null });
    store.get().register({ repo: REPO, pr, runId, task: `demo/T-${pr}`, implementer: `impl-${pr}`, policy: OWNER_GATE_POLICY });
  };
  at("run-101", 101, "sh-wake-implementer");
  at("run-103", 103, "sh-order-wait");
  new MergeOrder(host.db).reserve({ repo: REPO, runId: "run-101", pr: 101, headSha: "head-101", baseSha: "base-1", paths: [SHARED], ahead: [], since: minutes(0), reason: "conflict at head-101" });
  routes.shepherd!.mergeOrder!.waits.set("run-103", { repo: REPO, pr: 103, behind: 101, reason: WAIT });
  return partialFake<FactoryContext>({ host, shepherd: routes.shepherd! });
}

const { "shepherd.timeline": timelineCommand, "shepherd.status": statusCommand } = SHEPHERD_COMMAND_MAP;
const timeline = (ctx: FactoryContext) => timelineCommand.run(timelineCommand.args.parse({ repo: REPO, pr: 103 }), ctx);
const status = (ctx: FactoryContext) => statusCommand.run(statusCommand.args.parse({ repo: REPO, pr: 103 }), ctx);

describe("a run parked behind the merge-order guard (TP-4137)", () => {
  it("names the reservation, its holder's phase and since in the timeline row", async () => {
    const ctx = parkedWorld();

    const { row } = await timeline(ctx);

    expect(row.phase).toBe("merging");
    expect(row.nextAction).toBe(NAMED);
    expect(row.orderWait).toEqual({ behind: 101, holderPhase: "fixing", since: minutes(0), reason: NAMED });
    expect(row.stalled?.reason).toMatch(/over the \d+ min limit; /);
    expect(row.stalled?.reason.endsWith(NAMED)).toBe(true);
  });

  it("names the same wait in the status row", async () => {
    const ctx = parkedWorld();

    const [row] = await status(ctx);

    expect(row?.nextAction).toBe(NAMED);
    expect(row?.stalled?.reason).toContain(NAMED);
  });

  it("names only the wait once the holder's reservation is gone", async () => {
    const ctx = parkedWorld();
    new MergeOrder(ctx.host.db).release(REPO, "run-101", { at: minutes(20), actor: "demo-seat", reason: "landed" });

    const { row } = await timeline(ctx);

    expect(row.orderWait).toEqual({ behind: 101, holderPhase: null, since: null, reason: WAIT });
  });
});
