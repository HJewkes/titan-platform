import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub } from "@titan-design/github";
import { describe, expect, it, vi } from "vitest";
import type { FactoryHost } from "../host.js";
import { DEAD_END_SEAT } from "../test-support/dead-end.js";
import { REGISTRANT, deadEndSeatOn, exitWorld, startExit } from "../test-support/dead-end-route.js";
import { H1, gateId, gateOpened } from "../test-support/land.js";
import { SHAPE_SEAT, elevenShapes, openShape, otherShapes, routeShapeWorld, shapeWorld } from "../test-support/readdress.js";
import { readdressDeadEnds } from "./readdress.js";

const pendingSteps = (host: FactoryHost, runId: string): string[] => host.pendingGates().filter((gate) => gate.runId === runId).map((gate) => gate.stepId);

async function openAll(world: ReturnType<typeof shapeWorld>, shapes: ReturnType<typeof elevenShapes>, firstPr: number): Promise<string[]> {
  const runIds = shapes.map((shape, index) => openShape(world, firstPr + index, shape));
  await vi.waitFor(() => expect(world.host.pendingGates()).toHaveLength(runIds.length));
  return runIds;
}

describe("shepherd readdress-dead-ends (TP-4759)", () => {
  it("without --apply lists the eleven gate shapes with each addressee and cancels nothing", async () => {
    const world = shapeWorld();
    await openAll(world, elevenShapes(), 1);

    const report = await readdressDeadEnds(world.host, world.services);

    expect(report.applied).toBe(false);
    expect(report.gates.map(({ pr, kind, seat }) => [pr, kind, seat])).toEqual([
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((pr) => [pr, "exited-without-push", SHAPE_SEAT]),
      [9, "fix-first-runaway", null],
      [10, "fix-first-runaway", null],
      [11, "failed-rounds", SHAPE_SEAT],
    ]);
    expect(report.gates.every((gate) => !gate.cancelled)).toBe(true);
    expect(world.host.pendingGates()).toHaveLength(11);
  });

  it("never readdresses an approve-merge under authority, shepherd-merge-guard, another route row or a rule, nor another send-back", async () => {
    const world = shapeWorld();
    await openAll(world, otherShapes(), 21);

    const report = await readdressDeadEnds(world.host, world.services, { apply: true });

    expect(report.gates).toEqual([]);
    expect(world.host.pendingGates()).toHaveLength(otherShapes().length);
  });

  it("after --apply a run resumed on a pre-TP-4759 exit sent-back re-opens sh-dead-end at the same head for the seat", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp4759-s5-")), "factory.db");
    const fake = fakeGitHub();
    deadEndSeatOn(false);
    const before = exitWorld({ kind: "fix-proof", dbPath }, fake);
    const runId = startExit(before);
    await gateOpened(before.host, gateId(runId, "sh-sent-back"));
    before.host.close();

    deadEndSeatOn();
    const after = exitWorld({ kind: "fix-proof", dbPath }, fake);
    expect(await after.host.adopt()).toEqual([runId]);
    const report = await readdressDeadEnds(after.host, after.services, { apply: true });
    await gateOpened(after.host, gateId(runId, "sh-dead-end"));

    expect(report.gates.map(({ seat, cancelled }) => ({ seat, cancelled }))).toEqual([{ seat: REGISTRANT, cancelled: true }]);
    expect(after.host.gates.get(gateId(runId, "sh-sent-back"))?.status).toBe("cancelled");
    expect(after.host.gates.get(gateId(runId, "sh-dead-end"))?.prompt).toContain(`at head ${H1} reached a dead end (exited-without-push)`);
    expect(pendingSteps(after.host, runId)).toEqual(["sh-dead-end"]);
    expect(after.sends).toEqual([REGISTRANT]);
  });

  it.each(["fix-first-runaway", "failed-rounds"] as const)("after --apply a run paused on a %s approve-merge re-opens sh-dead-end at the same head for the seat", async (escalation) => {
    const world = routeShapeWorld(escalation);
    await gateOpened(world.host, gateId(world.runId, "approve-merge"));

    await readdressDeadEnds(world.host, world.services, { apply: true });
    await gateOpened(world.host, gateId(world.runId, "sh-dead-end"));

    const gate = world.host.gates.get(gateId(world.runId, "sh-dead-end"));
    expect(gate?.rule?.ruleId).toBe(`dead-end/${escalation}`);
    expect(gate?.prompt).toContain(`at head ${H1} reached a dead end (${escalation})`);
    expect(gate?.prompt).toContain(`Seat ${DEAD_END_SEAT} answers`);
    expect(pendingSteps(world.host, world.runId)).toEqual(["sh-dead-end"]);
  });
});
