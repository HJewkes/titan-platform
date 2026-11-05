import { fakeSha } from "@titan-design/github";
import type { AgentRow } from "@titan-design/agent-dispatch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deadEndAddress, type DeadEndPorts } from "./dead-end.js";
import { coordinatorEvidencePolicy, type CoordinatorEvidence } from "../coordinator-evidence.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { DEAD_END_SEAT, deadEndParam, deadEndRoutes, deadEndWorkflow } from "../test-support/dead-end.js";
import { gateId, gateOpened } from "../test-support/land.js";
import { liveRow } from "../test-support/registrant-routing.js";
import { OWNER } from "../test-support/resolver.js";

const REPO = "o/r";
const [H1, H2, H3] = [fakeSha("dead-end-1"), fakeSha("dead-end-2"), fakeSha("dead-end-3")];
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function started(deadEnd: string): { host: FactoryHost; runId: string } {
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [deadEndWorkflow], routes: deadEndRoutes(), gatePollMs: 5 });
  hosts.push(host);
  return { host, runId: host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", deadEnd }) };
}

const offered = (host: FactoryHost, id: string): unknown => host.gates.get(id)?.questions?.[0]?.options.map((option) => option.id);

describe("a dead-end seat gate", () => {
  it("respawn waits for a new head and opens no second gate at that head; a third respawn is not offered", async () => {
    const { host, runId } = started(deadEndParam([H1, H2, H3]));
    const gates = [0, 1, 2].map((iteration) => gateId(runId, "sh-dead-end", iteration));

    for (const [index, head] of [H1, H2].entries()) {
      await gateOpened(host, gates[index]!);
      host.gates.resolve(gates[index]!, { decision: "respawn", headSha: head }, OWNER);
    }
    await gateOpened(host, gates[2]!);

    const results = Object.values(host.runtime.status(runId)!.stepResults);
    expect(results.filter((result) => result.stepId.startsWith("await-new-head")).map((result) => result.stepId)).toEqual(["await-new-head:0", "await-new-head:1"]);
    expect(gates.map((id) => host.gates.get(id)?.prompt.match(/at head (\w+)/)?.[1])).toEqual([H1, H2, H3]);
    expect(offered(host, gates[0]!)).toEqual(["respawn", "replan", "abandon"]);
    expect(host.gates.get(gates[2]!)?.prompt).toMatch(/answers: replan, abandon\?$/);
    expect(host.gates.get(gates[2]!)?.schema).toMatchObject({ properties: { decision: { enum: ["replan", "abandon"] } } });
    expect(host.gates.get(gates[0]!)?.rule).toEqual({ table: "shepherd-dead-end", version: "1", ruleId: "dead-end/exited-without-push", resolvers: ["owner-terminal", "owner-remote"], delegates: ["coordinator"] });
  });

  it.each([
    ["exited-without-push", "waive-proof"],
    ["fix-first-runaway", "owner-merge"],
  ] as const)("a coordinator's waive-proof or owner-merge is refused even where the schema offers it (%s)", async (kind, ownerOnly) => {
    const { host, runId } = started(deadEndParam([H1], kind, true));
    const id = gateId(runId, "sh-dead-end");
    await gateOpened(host, id);
    const gate = host.gates.get(id)!;
    const evidence: CoordinatorEvidence = { kind: "seat-dead-end", gateId: id, repo: REPO, pr: 1, headSha: H1, seat: DEAD_END_SEAT, pull: { state: "open", headSha: H1 }, readAt: "2026-11-04T00:00:00.000Z" };
    const admits = (decision: string): boolean => coordinatorEvidencePolicy(gate, { class: "coordinator", id: DEAD_END_SEAT, channel: "test" }, { decision, headSha: H1 }, evidence);

    expect(offered(host, id)).toEqual(["respawn", "replan", "abandon", ownerOnly]);
    expect([ownerOnly, "respawn", "replan", "abandon"].map(admits)).toEqual([false, true, true, true]);
  });

  it("with no seat to address, asks no seat gate and leaves the owner's gate to the caller", async () => {
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [deadEndWorkflow], routes: deadEndRoutes(null), gatePollMs: 5 });
    hosts.push(host);
    const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", deadEnd: deadEndParam([H1]) });

    await vi.waitFor(() => expect(host.runtime.status(runId)?.status).toBe("completed"));
    expect(host.gates.get(gateId(runId, "sh-dead-end"))).toBeUndefined();
  });
});

const agent = (name: string, live: boolean): AgentRow => ({ ...liveRow(name), ...(live ? {} : { presence: "exited", status: "finished" }) });

function addressPorts(roster: AgentRow[], repoSeat: string | undefined, hubSeat?: string): DeadEndPorts {
  return { lineage: () => undefined, roster: async () => roster, repoSeat: () => repoSeat, hubSeat: () => hubSeat };
}

describe("a dead-end gate's repo-seat fallback", () => {
  const target = { repo: REPO, pr: 1 };

  it("a retired single seat leaves the gate the owner's", async () => {
    const ports = addressPorts([agent("coord", false)], "coord");

    expect(await deadEndAddress(ports, target)).toBeUndefined();
  });

  it("a live hubSeat stands in for a retired single seat", async () => {
    const ports = addressPorts([agent("coord", false), agent("hub", true)], "coord", "hub");

    expect(await deadEndAddress(ports, target)).toBe("hub");
  });

  it("a live single seat is unchanged", async () => {
    const ports = addressPorts([agent("coord", true), agent("hub", true)], "coord", "hub");

    expect(await deadEndAddress(ports, target)).toBe("coord");
  });
});
