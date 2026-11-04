import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha } from "@titan-design/github";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { deadEndRoutes } from "../test-support/dead-end.js";
import { REGISTRANT, deadEndSeatOn, exitWorld, routeWorkflow, startExit } from "../test-support/dead-end-route.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";

const H2 = fakeSha("dead-end-route-2");

const stepIds = (host: FactoryHost, runId: string): string[] => Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
const pendingSteps = (host: FactoryHost, runId: string): string[] => host.pendingGates().filter((gate) => gate.runId === runId).map((gate) => gate.stepId);
const options = (host: FactoryHost, id: string): string[] | undefined => host.gates.get(id)?.questions?.[0]?.options.map((option) => option.id);

describe("a fixer's exit with no push, with the dead-end seat route on (TP-4759)", () => {
  it.each(["ci-red", "fix-proof"] as const)("opens sh-dead-end for the registrant's seat after a %s wake, where no single seat owns the repo", async (kind) => {
    deadEndSeatOn();
    const world = exitWorld({ kind });
    const runId = startExit(world);
    const id = gateId(runId, "sh-dead-end");

    await gateOpened(world.host, id);

    expect(world.host.gates.get(id)?.prompt).toContain(`Seat ${REGISTRANT} answers`);
    expect(world.host.gates.get(id)?.rule?.ruleId).toBe("dead-end/exited-without-push");
    expect(options(world.host, id)).toEqual(kind === "fix-proof" ? ["respawn", "replan", "abandon", "waive-proof"] : ["respawn", "replan", "abandon"]);
    expect(world.sends).toEqual([REGISTRANT]);
    expect(pendingSteps(world.host, runId)).toEqual(["sh-dead-end"]);
  });

  it("with no resolvable seat the owner's sent-back gate opens as before, never the hub seat's", async () => {
    deadEndSeatOn();
    const world = exitWorld({ kind: "fix-proof", roster: [], hubSeat: "tc-hub" });
    const runId = startExit(world);

    await gateOpened(world.host, gateId(runId, "sh-sent-back"));

    expect(world.host.gates.get(gateId(runId, "sh-sent-back"))?.prompt).toMatch(/Await a new head or abandon\?$/);
    expect(world.host.gates.get(gateId(runId, "sh-dead-end"))).toBeUndefined();
    expect(stepIds(world.host, runId)).toContain("sh-dead-end-address");
  });
});

describe("a route escalation, with the dead-end seat route on (TP-4759)", () => {
  function routed(escalation: "fix-first-runaway" | "failed-rounds", dbPath = ":memory:"): { host: FactoryHost; runId: string } {
    const host = openFactoryHost({ dbPath, workflows: [routeWorkflow], routes: deadEndRoutes(), gatePollMs: 5 });
    onTestFinished(() => host.close());
    return { host, runId: host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", escalation }) };
  }

  it.each(["fix-first-runaway", "failed-rounds"] as const)("%s opens sh-dead-end for the seat, not approve-merge", async (escalation) => {
    deadEndSeatOn();
    const { host, runId } = routed(escalation);
    const id = gateId(runId, "sh-dead-end");

    await gateOpened(host, id);

    expect(host.gates.get(id)?.rule?.ruleId).toBe(`dead-end/${escalation}`);
    expect(host.gates.get(id)?.prompt).toContain(`at head ${H1}`);
    expect(options(host, id)).toEqual(["respawn", "replan", "abandon", "owner-merge"]);
    expect(pendingSteps(host, runId)).toEqual(["sh-dead-end"]);
  });

  it("a run resumed while paused on a pre-TP-4759 approve-merge keeps that gate and records no address", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp4759-")), "factory.db");
    deadEndSeatOn(false);
    const before = routed("fix-first-runaway", dbPath);
    await gateOpened(before.host, gateId(before.runId, "approve-merge"));
    before.host.close();

    deadEndSeatOn();
    const after = openFactoryHost({ dbPath, workflows: [routeWorkflow], routes: deadEndRoutes(), gatePollMs: 5 });
    onTestFinished(() => after.close());
    expect(await after.adopt()).toEqual([before.runId]);
    await vi.waitFor(() => expect(after.runtime.status(before.runId)?.currentStep).toBe("approve-merge"));
    after.runtime.signal(before.runId, "approve-merge", { decision: "abandon" }, OWNER);

    await vi.waitFor(() => expect(after.runtime.status(before.runId)?.status).toBe("completed"));
    expect(stepIds(after, before.runId)).toEqual(["approve-merge"]);
    expect(after.gates.get(gateId(before.runId, "sh-dead-end"))).toBeUndefined();
  });
});

describe("a run paused on a pre-TP-4759 sent-back gate", () => {
  it("keeps that gate when resumed with the seat route on, asking no seat", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp4759-")), "factory.db");
    const fake = fakeGitHub();
    deadEndSeatOn(false);
    const first = exitWorld({ kind: "fix-proof", dbPath }, fake);
    const runId = startExit(first);
    await gateOpened(first.host, gateId(runId, "sh-sent-back"));
    first.host.close();

    deadEndSeatOn();
    const { host, sends } = exitWorld({ kind: "fix-proof", dbPath }, fake);
    expect(await host.adopt()).toEqual([runId]);
    await vi.waitFor(() => expect(host.runtime.status(runId)?.currentStep).toBe("sh-sent-back"));
    host.runtime.signal(runId, "sh-sent-back", { decision: "await-new-head" }, OWNER);
    fake.pushHead(1, H2);

    await gateOpened(host, gateId(runId, "approve-merge"));
    expect(stepIds(host, runId)).not.toContain("sh-dead-end-address");
    expect(host.gates.get(gateId(runId, "sh-dead-end"))).toBeUndefined();
    expect(sends).toEqual([]);
  });
});
