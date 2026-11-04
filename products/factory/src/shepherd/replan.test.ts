import { tmpdir } from "node:os";
import type { AgentRow } from "@titan-design/agent-dispatch";
import { fakeSha } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { readPath } from "../narrow.js";
import { DEAD_END_SEAT, deadEndParam, deadEndRoutes, deadEndWorkflow } from "../test-support/dead-end.js";
import { gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import type { SpawnRequest } from "./agents.js";
import type { ReplanPorts } from "./spawn-ports.js";

const REPO = "o/r";
const H1 = fakeSha("replan-1");
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const ROW: AgentRow = { name: "fx-synthetic-1", agentId: "agent-1", state: "exited", presence: "exited", status: "finished", profile: "bd-fixer", surface: "headless", cwd: tmpdir(), sessionId: "session-1", transcriptPath: "/transcripts/session-1.jsonl", transcriptExists: true, generation: 1 };
const SESSIONS = [{ agent: "fx-synthetic-1", sessionId: "session-1" }, { agent: "fx-synthetic-2", sessionId: "session-2" }];

function replanPorts(spawn: (request: SpawnRequest) => Promise<void>): ReplanPorts {
  return { profile: "bd-planner", agents: { roster: async () => [ROW], spawn }, cwdFor: () => tmpdir() };
}

function started(replan: ReplanPorts, heads: readonly string[] = [H1]): { host: FactoryHost; runId: string } {
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [deadEndWorkflow], routes: deadEndRoutes(DEAD_END_SEAT, { replan }), gatePollMs: 5 });
  hosts.push(host);
  const deadEnd = deadEndParam(heads, "fix-first-runaway", false, { sessions: SESSIONS, trail: ["round 1 FIX_FIRST: split the parser"] });
  return { host, runId: host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", deadEnd }) };
}

const stepIds = (host: FactoryHost, runId: string): string[] => Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
const recommended = (host: FactoryHost, id: string): unknown => host.gates.get(id)?.questions?.[0]?.options.filter((option) => option.recommended).map((option) => option.id);

describe("a dead-end gate's replan answer", () => {
  it("replan spawns bd-planner once with each failed session's transcript path in the brief, and the run waits for a new head", async () => {
    const spawned: SpawnRequest[] = [];
    const { host, runId } = started(replanPorts(async (request) => void spawned.push(request)));
    const id = gateId(runId, "sh-dead-end");
    await gateOpened(host, id);

    host.gates.resolve(id, { decision: "replan", headSha: H1 }, OWNER);
    await vi.waitFor(() => expect(host.runtime.status(runId)?.status).toBe("completed"));

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ profile: "bd-planner", cwd: tmpdir() });
    expect(spawned[0]!.brief).toContain("- fx-synthetic-1: session session-1, transcript /transcripts/session-1.jsonl");
    expect(spawned[0]!.brief).toContain("- fx-synthetic-2: session session-2, transcript not on the roster");
    expect(spawned[0]!.brief).toContain("- round 1 FIX_FIRST: split the parser");
    expect(spawned[0]!.brief).toContain(`Send the plan to ${DEAD_END_SEAT} with chat_send`);
    expect(stepIds(host, runId).filter((stepId) => stepId.startsWith("sh-replan") || stepId.startsWith("await-new-head"))).toEqual([`sh-replan:${H1}`, expect.stringMatching(/^await-new-head/)]);
    expect(host.gates.get(gateId(runId, "sh-dead-end", 1))).toBeUndefined();
  });

  it("a refused replan spawn tells the seat and asks again without replan recommended", async () => {
    const { host, runId } = started(replanPorts(async () => Promise.reject(new Error("profile is not installed"))), [H1, H1, H1]);
    for (const [iteration, head] of [H1, H1].entries()) {
      await gateOpened(host, gateId(runId, "sh-dead-end", iteration));
      host.gates.resolve(gateId(runId, "sh-dead-end", iteration), { decision: "respawn", headSha: head }, OWNER);
    }
    const capped = gateId(runId, "sh-dead-end", 2);
    await gateOpened(host, capped);
    expect(recommended(host, capped)).toEqual(["replan"]);

    host.gates.resolve(capped, { decision: "replan", headSha: H1 }, OWNER);
    const reasked = gateId(runId, "sh-dead-end", 3);
    await gateOpened(host, reasked);

    const notices = Object.values(host.runtime.status(runId)!.stepResults).filter((result) => result.stepId.startsWith("sh-seat-notice"));
    const told = notices.map((notice) => String(readPath(notice.data, "result", "detail")));
    expect(told.filter((detail) => /the replan planner replan-[\w-]+ was not spawned \(profile is not installed\), so Shepherd asks again$/.test(detail))).toHaveLength(1);
    expect(host.gates.get(reasked)?.questions?.[0]?.options.map((option) => option.id)).toEqual(["replan", "abandon", "owner-merge"]);
    expect(recommended(host, reasked)).toEqual([]);
  });

  it("a second replan at the same head after a refused spawn spawns the planner once and waits for a new head", async () => {
    const spawned: SpawnRequest[] = [];
    const spawn = vi.fn<(request: SpawnRequest) => Promise<void>>().mockRejectedValueOnce(new Error("profile is not installed"));
    spawn.mockImplementation(async (request) => void spawned.push(request));
    const { host, runId } = started(replanPorts(spawn));
    await gateOpened(host, gateId(runId, "sh-dead-end"));
    host.gates.resolve(gateId(runId, "sh-dead-end"), { decision: "replan", headSha: H1 }, OWNER);

    const reasked = gateId(runId, "sh-dead-end", 1);
    await gateOpened(host, reasked);
    host.gates.resolve(reasked, { decision: "replan", headSha: H1 }, OWNER);
    await vi.waitFor(() => expect(host.runtime.status(runId)?.status).toBe("completed"));

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawned).toHaveLength(1);
    expect(stepIds(host, runId).filter((stepId) => stepId.startsWith("await-new-head"))).toHaveLength(1);
    expect(host.gates.get(gateId(runId, "sh-dead-end", 2))).toBeUndefined();
  });
});
