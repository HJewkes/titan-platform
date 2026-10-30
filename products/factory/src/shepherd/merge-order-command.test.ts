import { fakeGitHub, githubPort } from "@titan-design/github";
import { EXIT } from "@titan-design/registry";
import { partialFake } from "@titan-design/test-kit";
import { WorkflowRunStore } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import type { FactoryContext } from "../registry.js";
import { factoryRoutesFor } from "../workflows.js";
import { eventsSince } from "./events.js";
import { formatShepherd } from "./format.js";
import { orderCommand, statusOrder } from "./merge-order-command.js";
import { MergeOrder, type MergeOrderRules, type Reservation } from "./merge-order.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { MergeOrderServices } from "./services.js";
import { shepherdStoreRef } from "./store.js";
import type { WatchRow } from "./view.js";

const REPO = "demo/repo";
const SHARED = "docs/shared.md";
const AT = Date.parse("2026-10-23T10:00:00.000Z");
const minutes = (n: number): string => new Date(AT + n * 60_000).toISOString();
const RULES: MergeOrderRules = () => ({ enabled: true, ttlMinutes: 120, ignore: [] });

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const reservation = (runId: string, pr: number, since: string): Reservation => ({ repo: REPO, runId, pr, headSha: `head-${pr}`, baseSha: "base-1", paths: [SHARED], ahead: [], since, reason: `conflict at head-${pr}` });

/** Two overlapping reservations, #101 then #102, each run driving; the clock reads 30 minutes after #101 reserved. */
function orderWorld() {
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fakeGitHub().wire), store, now: () => AT + 30 * 60_000, mergeOrderRules: RULES });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [], routes });
  hosts.push(host);
  const runs = new WorkflowRunStore(host.db);
  for (const id of ["run-101", "run-102"]) runs.create({ id, workflowName: "shepherd-pr", params: { repo: REPO }, status: "running", currentStep: null, stepResults: {}, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: minutes(0), completedAt: null, error: null });
  const order = new MergeOrder(host.db);
  order.reserve(reservation("run-101", 101, minutes(0)));
  order.reserve(reservation("run-102", 102, minutes(5)));
  const services: MergeOrderServices = routes.shepherd!.mergeOrder!;
  services.waits.set("run-103", { repo: REPO, pr: 103, behind: 101, reason: `merge order: waiting behind #101 (${SHARED})` });
  return { host, order, services, store: store.get(), ctx: partialFake<FactoryContext>({ host, shepherd: routes.shepherd! }) };
}

const run = (w: ReturnType<typeof orderWorld>, args: object) => orderCommand.run(orderCommand.args.parse(args), w.ctx);

const row = (runId: string, pr: number, phase: WatchRow["phase"]): WatchRow => ({
  ...{ repo: REPO, pr, branch: `agent-chat/demo-${pr}`, runId, task: `demo/T-${pr}`, phase, headSha: `head-${pr}`, phaseSince: minutes(0), nextAction: "waiting to merge" },
  ...{ pendingGate: null, held: null, stalled: null, outcome: null },
});

describe("shepherd order", () => {
  it("lists each reservation with its age, the earlier reservation it waits behind and the PRs waiting behind it", async () => {
    const w = orderWorld();

    const { reservations } = await run(w, { action: "list", repo: REPO });

    expect(reservations.map(({ pr, ageMinutes, state, behind, waiting }) => ({ pr, ageMinutes, state, behind, waiting }))).toEqual([
      { pr: 101, ageMinutes: 30, state: "live", behind: [], waiting: [103] },
      { pr: 102, ageMinutes: 25, state: "live", behind: [101], waiting: [] },
    ]);
  });

  it("lists a reservation whose run a person holds as held, and no later reservation waits behind it (TP-4133)", async () => {
    const w = orderWorld();
    w.store.register({ repo: REPO, pr: 101, runId: "run-101", task: "demo/T-101", implementer: "impl-101", policy: OWNER_GATE_POLICY });
    w.store.hold("run-101", "g10-adversary: policy touch");

    const { reservations } = await run(w, { action: "list", repo: REPO });

    expect(reservations.map(({ pr, state, behind }) => ({ pr, state, behind }))).toEqual([
      { pr: 101, state: "held", behind: [] },
      { pr: 102, state: "live", behind: [] },
    ]);
  });

  it("clears a reservation by hand and logs the release with the caller and the reason", async () => {
    const w = orderWorld();

    const result = await run(w, { action: "clear", repo: REPO, pr: 101, reason: "stuck in review", actor: "demo-seat" });

    expect(result.cleared?.pr).toBe(101);
    expect(w.order.list(REPO).map((reservation) => reservation.pr)).toEqual([102]);
    expect(eventsSince(w.host.db).filter((event) => event.kind === "order-release").map(({ runId, actor, reason }) => ({ runId, actor, reason }))).toEqual([
      { runId: "run-101", actor: "demo-seat", reason: "cleared by hand: stuck in review" },
    ]);
  });

  it("refuses to clear a PR that holds no reservation, and changes nothing", async () => {
    const w = orderWorld();

    await expect(run(w, { action: "clear", repo: REPO, pr: 999, reason: "typo", actor: "demo-seat" })).rejects.toMatchObject({ code: EXIT.DATAERR });
    expect(w.order.list(REPO)).toHaveLength(2);
    expect(eventsSince(w.host.db).filter((event) => event.kind === "order-release")).toEqual([]);
  });
});

describe("shepherd status with merge order", () => {
  it("names the reservation a PR is waiting behind, and the reservation on the reserving row", () => {
    const w = orderWorld();
    const rows = [row("run-103", 103, "merging"), row("run-101", 101, "fixing")].map((watch) => ({ ...watch, ...statusOrder(w.services, watch), stackFrozen: false }));

    const text = formatShepherd("shepherd.status", rows);

    expect(text).toContain(`${REPO}#103 merging head-10 merge order: waiting behind #101 (${SHARED})`);
    expect(text).toContain(`${REPO}#101 fixing head-10 waiting to merge [merge order: reserved 1 path(s) since ${minutes(0)}, live; #103 waiting]`);
  });

  it("names the merge-order wait in the stall flag of a merge past its phase limit (TP-4133)", () => {
    const w = orderWorld();
    const stalled = { ...row("run-103", 103, "merging"), stalled: { reason: "30 min in merging, over the 15 min limit" } };

    expect(statusOrder(w.services, stalled).stalled).toEqual({ reason: `30 min in merging, over the 15 min limit; merge order: waiting behind #101 (${SHARED}); #101 reserved since ${minutes(0)}` });
    expect(statusOrder(w.services, row("run-103", 103, "merging")).stalled).toBeUndefined();
  });
});
