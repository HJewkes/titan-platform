import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { partialFake } from "@titan-design/test-kit";
import type { AgentRow } from "@titan-design/agent-dispatch";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { StepResult, WorkflowContext } from "@titan-design/workflow";
import type { SpawnRequest } from "./agents.js";
import type { ShepherdPhases } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef, type ShepherdStoreRef } from "./store.js";
import { isVisualGate, packetDirFor, packetTriggering, visualPacket, type PacketInput, type VisualPacketMode, type VisualPacketPorts } from "./visual-packet-trigger.js";

const H2 = fakeSha("visual-next-head");
const VISUAL: EffectivePolicy = { ...OWNER_GATE_POLICY, ownerGateReason: "gate-2-visual", seat: "design-seat" };
const PLAIN: EffectivePolicy = { ...OWNER_GATE_POLICY, ownerGateReason: "owner-asked", seat: "design-seat" };
/** The reviewer says MERGE at every head, so the seat's owner gate is what asks. */
const REVIEWED: ShepherdPhases = {
  wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
  review: async (_ctx, request) => ({ kind: "MERGE", headSha: request.headSha, evidence: {} }),
};
const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  vi.unstubAllEnvs();
});

const scratch = (): string => mkdtempSync(join(tmpdir(), "visual-packet-"));

/** Records every spawn; `refuse` makes each one throw as a missing profile does. */
function packagerAgents(refuse?: string) {
  const spawns: SpawnRequest[] = [];
  const roster: AgentRow[] = [];
  const agents: NonNullable<VisualPacketPorts["agents"]> = {
    roster: async () => roster,
    spawn: async (request) => {
      if (refuse !== undefined) throw new Error(refuse);
      spawns.push(request);
    },
  };
  return { spawns, agents };
}

function rosterRow(name: string): AgentRow {
  return { name, agentId: "agent-1", state: "live", presence: "live", status: "running", profile: "review-packager", surface: "headless", cwd: "/tmp", sessionId: "", generation: 1 };
}

/** The seat checkout every repo resolves to; a real dir, as the trigger refuses one that is not. */
const CLONE = scratch();

function ports(mode: VisualPacketMode, agents: VisualPacketPorts["agents"], stateDir = scratch()): VisualPacketPorts {
  return { mode, profile: "review-packager", stateDir, cwdFor: () => CLONE, ...(agents && { agents }) };
}

/** CI is green at every head, with a visual job whose run id the packet names. */
function greenWithVisualJob(fake: FakeGitHub): void {
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2), successRun("visual", 7, undefined, "success", undefined, pr.headSha)]);
}

function shepherdHost(fake: FakeGitHub, store: ShepherdStoreRef, visual: VisualPacketPorts | undefined, dbPath = ":memory:"): FactoryHost {
  let clock = 0;
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), park: async () => ({ lines: [] }), ...(visual && { visualPacket: visual }) });
  const host = openFactoryHost({ dbPath, workflows: [shepherdPrWorkflow(REVIEWED)], routes, gatePollMs: 5 });
  hosts.push(host);
  return host;
}

interface World {
  fake: FakeGitHub;
  store: ShepherdStoreRef;
  host: FactoryHost;
  runId: string;
}

async function gatedAtH1(visual: VisualPacketPorts | undefined, policy: EffectivePolicy = VISUAL, dbPath?: string): Promise<World> {
  const fake = fakeGitHub();
  greenWithVisualJob(fake);
  fake.addPr({ headSha: H1 });
  const store = shepherdStoreRef();
  const host = shepherdHost(fake, store, visual, dbPath);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy });
  await gateOpened(host, gateId(runId, "approve-merge"));
  return { fake, store, host, runId };
}

const RecordedPacket = z.object({ result: z.record(z.string(), z.unknown()) });

const packetSteps = (host: FactoryHost, runId: string) =>
  Object.entries(host.runtime.status(runId)!.stepResults)
    .filter(([key]) => key.startsWith("sh-visual-packet:"))
    .map(([, result]) => RecordedPacket.parse(result.data).result);

describe("a visual approve-merge gate under shepherd.visualPacket on", () => {
  it("spawns the packager once, with the run, gate, head, tree, visual CI run and packet dir in its brief", async () => {
    const { spawns, agents } = packagerAgents();
    const stateDir = scratch();

    const { host, runId } = await gatedAtH1(ports("on", agents, stateDir));

    const packetDir = packetDirFor(stateDir, runId, H1);
    expect(packetDir).toBe(join(stateDir, "packets", runId, H1));
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({ profile: "review-packager", cwd: CLONE });
    for (const line of [`Head: ${H1}`, `Shepherd run: ${runId}`, `Gate: ${runId}/approve-merge`, "Visual CI run: 1007", `Packet dir: ${packetDir}`, `Clone: ${CLONE}`, `--run 1007 --clone ${CLONE} --out ${packetDir}`]) {
      expect(spawns[0]!.brief).toContain(line);
    }
    expect(spawns[0]!.brief).toMatch(/Head tree: [0-9a-f]{40}/);
    expect(packetSteps(host, runId)).toEqual([expect.objectContaining({ event: "visual-packet-spawned", packetDir, agent: spawns[0]!.name })]);
  });

  it("a restart at the same run and head replays the recorded spawn and starts no second packager", async () => {
    const dbPath = join(scratch(), "factory.db");
    const { spawns, agents } = packagerAgents();
    const visual = ports("on", agents);
    const first = await gatedAtH1(visual, VISUAL, dbPath);
    first.host.close();

    const second = shepherdHost(first.fake, first.store, visual, dbPath);
    await second.adopt();
    await vi.waitFor(() => expect(second.runtime.status(first.runId)?.status).toBe("paused"));

    expect(spawns).toHaveLength(1);
    expect(second.runtime.status(first.runId)?.status).not.toBe("recovery_required");
  });

  it("a new head opens a new gate and spawns a second packager for that head", async () => {
    const { spawns, agents } = packagerAgents();
    const { fake, host, runId } = await gatedAtH1(ports("on", agents));

    fake.pushHead(1, H2);
    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
    await gateOpened(host, gateId(runId, "approve-merge", 1));

    expect(spawns.map((spawn) => spawn.brief.match(/^Head: (\w+)$/m)?.[1])).toEqual([H1, H2]);
    expect(spawns[1]!.brief).toContain(`Gate: ${runId}/approve-merge:1`);
  });

  it("a restart after the run moved on to a new head starts neither packager again", async () => {
    const dbPath = join(scratch(), "factory.db");
    const { spawns, agents } = packagerAgents();
    const visual = ports("on", agents);
    const first = await gatedAtH1(visual, VISUAL, dbPath);
    first.fake.pushHead(1, H2);
    first.host.runtime.signal(first.runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
    await gateOpened(first.host, gateId(first.runId, "approve-merge", 1));
    first.host.close();

    const second = shepherdHost(first.fake, first.store, visual, dbPath);
    await second.adopt();
    await vi.waitFor(() => expect(second.runtime.status(first.runId)?.status).toMatch(/^(paused|recovery_required)$/));

    expect(second.runtime.status(first.runId)?.status).toBe("paused");
    expect(spawns).toHaveLength(2);
  });

  it("a refused spawn records the failure with its reason and the gate still waits for the owner", async () => {
    const { spawns, agents } = packagerAgents("profile review-packager not found");

    const { host, runId } = await gatedAtH1(ports("on", agents));

    expect(spawns).toEqual([]);
    expect(packetSteps(host, runId)).toEqual([expect.objectContaining({ event: "visual-packet-spawn-failed", reason: "profile review-packager not found" })]);
    expect(host.runtime.status(runId)?.status).toBe("paused");
  });
});

describe("shepherd.visualPacket short of on spawns nothing", () => {
  it("shadow records where it would spawn, and spawns nothing", async () => {
    const { spawns, agents } = packagerAgents();
    const stateDir = scratch();

    const { host, runId } = await gatedAtH1(ports("shadow", agents, stateDir));

    expect(spawns).toEqual([]);
    expect(packetSteps(host, runId)).toEqual([expect.objectContaining({ event: "visual-packet-would-spawn", packetDir: packetDirFor(stateDir, runId, H1) })]);
  });

  it("off spawns nothing and records only that the flag was off, with no packet dir", async () => {
    const { spawns, agents } = packagerAgents();

    const { host, runId } = await gatedAtH1(ports("off", agents));

    expect(spawns).toEqual([]);
    expect(packetSteps(host, runId)).toEqual([{ event: "visual-packet-off" }]);
  });

  it("an approve-merge gate that is not visual records no packet step at all", async () => {
    const { spawns, agents } = packagerAgents();

    const { host, runId } = await gatedAtH1(ports("on", agents), PLAIN);

    expect(spawns).toEqual([]);
    expect(packetSteps(host, runId)).toEqual([]);
  });
});

describe("which approve-merge gates are visual", () => {
  const prompt = (rule: string) => `Merge PR #1 in ${REPO} at head ${H1}? CI is green. Policy ${rule}: synthetic reason`;

  it.each([
    ["the visual-path guard", prompt("shepherd-merge-guard/visual-path"), undefined, H1],
    ["any land gate of a gate-2-visual registration", prompt("authority/MRG-AU"), "gate-2-visual" as const, H1],
    ["the skill-path guard", prompt("shepherd-merge-guard/skill-path"), undefined, undefined],
    ["an escalation, even under gate-2-visual", prompt("shepherd-route/no-progress"), "gate-2-visual" as const, undefined],
  ])("%s", (_case, text, reason, head) => {
    expect(isVisualGate("approve-merge", text, reason)).toBe(head);
  });

  it("the owner's ask to accept a red head's regenerated baselines, and no other gate with its prompt", () => {
    const accept = `Accept the regenerated baselines of PR #1 in ${REPO} at head ${H1}? CI is red only on visual.`;

    expect([isVisualGate("sh-visual-accept", accept, undefined), isVisualGate("sh-visual-accept:1", accept, undefined)]).toEqual([H1, H1]);
    expect([isVisualGate("approve-merge", accept, undefined), isVisualGate("sh-visual-accept", prompt("shepherd-merge-guard/visual-path"), undefined)]).toEqual([undefined, undefined]);
  });
});

describe("the packet step's route", () => {
  const input: PacketInput = { runId: "run-synthetic-1", repo: REPO, pr: 1, headSha: H1, gateId: "run-synthetic-1/approve-merge" };
  const withVisualRun = () => {
    const fake = fakeGitHub();
    fake.setRuns(H1, [successRun("visual", 7, undefined, "success", undefined, H1)]);
    return githubPort(fake.wire);
  };

  it("an agent already on the roster under the packager's name is not spawned again", async () => {
    const { spawns, agents } = packagerAgents();
    const visual = ports("on", agents);
    const first = await visualPacket(withVisualRun(), visual, input);
    const onRoster: NonNullable<VisualPacketPorts["agents"]> = { ...agents, roster: async () => [rosterRow(first.agent!)] };

    const again = await visualPacket(withVisualRun(), { ...visual, agents: onRoster }, input);

    expect(spawns).toHaveLength(1);
    expect(again.event).toBe("visual-packet-spawned");
  });

  it("on with no agent-chat configured records a failed spawn instead of throwing", async () => {
    const result = await visualPacket(withVisualRun(), ports("on", undefined), input);

    expect(result).toMatchObject({ event: "visual-packet-spawn-failed", reason: "no agent-chat is configured" });
  });

  it("a head with no visual CI run spawns no packager and records why, in shadow as in on", async () => {
    const { spawns, agents } = packagerAgents();

    const results = [await visualPacket(githubPort(fakeGitHub().wire), ports("on", agents), input), await visualPacket(githubPort(fakeGitHub().wire), ports("shadow", agents), input)];

    expect(spawns).toEqual([]);
    expect(results).toEqual([0, 1].map(() => expect.objectContaining({ event: "visual-packet-spawn-failed", reason: `no visual CI run at ${H1}; a packager could only stop BLOCKED` })));
  });

  it("a repo with no seat checkout spawns no packager, as from-ci would have no clone to read", async () => {
    const { spawns, agents } = packagerAgents();

    const result = await visualPacket(withVisualRun(), { ...ports("on", agents), cwdFor: () => undefined }, input);

    expect(spawns).toEqual([]);
    expect(result).toMatchObject({ event: "visual-packet-spawn-failed", reason: `no checkout path is configured for ${REPO}` });
  });
});

describe("the packager's brief", () => {
  const input: PacketInput = { runId: "run-synthetic-1", repo: REPO, pr: 1, headSha: H1, gateId: "run-synthetic-1/approve-merge" };

  async function briefFor(over: Partial<VisualPacketPorts> = {}): Promise<{ brief: string; packetDir: string }> {
    const fake = fakeGitHub();
    fake.setRuns(H1, [successRun("visual", 7, undefined, "success", undefined, H1)]);
    const { spawns, agents } = packagerAgents();
    const visual = { ...ports("on", agents), ...over };
    await visualPacket(githubPort(fake.wire), visual, input);
    return { brief: spawns[0]!.brief, packetDir: packetDirFor(visual.stateDir, input.runId, H1) };
  }

  const BIN = "/opt/synthetic/bin/titan-review";
  const steps = (brief: string) => brief.split("\n").filter((line) => /^\d+\. /.test(line));

  it("builds with from-ci against the seat clone, then follows the prompt, then ends on a prose lint against the same clone", async () => {
    const { brief, packetDir } = await briefFor({ titanReviewBin: BIN });

    expect(steps(brief)).toEqual([
      `1. First, once: \`${BIN} packet from-ci --repo ${REPO} --pr 1 --head ${H1} --run 1007 --clone ${CLONE} --out ${packetDir}\`. If it fails, stop BLOCKED with its stderr.`,
      `2. Run \`${BIN} packet prompt\` and follow it to write \`${packetDir}/prose.json\`.`,
      "3. Never run from-ci again: it replaces the whole packet dir, prose.json with it. If the packet needs rebuilding, stop BLOCKED.",
      `4. Finish with \`${BIN} packet lint ${packetDir} --gate-head ${H1} --require prose --clone ${CLONE}\`. It must exit 0: fix prose.json until it does, or stop BLOCKED with its output.`,
    ]);
    expect(brief.trimEnd().split("\n").at(-1)).toBe(steps(brief).at(-1));
    expect(brief).not.toMatch(/PR body/);
  });

  it("names titan-review by $HOME/.local/bin when none is configured, read when the brief is written, never by a bare name", async () => {
    vi.stubEnv("HOME", "/srv/synthetic-owner");

    const { brief } = await briefFor();

    expect(brief).toContain("titan-review: /srv/synthetic-owner/.local/bin/titan-review");
    for (const step of steps(brief).filter((line) => line.includes("titan-review"))) expect(step).toContain("`/srv/synthetic-owner/.local/bin/titan-review packet ");
    expect(brief).not.toMatch(/`titan-review /);
  });
});

describe("the replay guard around the packet step", () => {
  const packetStep = `sh-visual-packet:${H1}`;
  const gatePrompt = `Merge PR #1 in ${REPO} at head ${H1}? CI is green. Policy shepherd-merge-guard/visual-path: synthetic reason`;

  interface Position {
    next?: string;
    resumed?: string;
    iterations?: Record<string, number>;
  }

  /** A run context at a given replay position; `dispatched` collects the steps the trigger records. */
  async function reachGate(position: Position) {
    const dispatched: string[] = [];
    const ctx = partialFake<WorkflowContext>({
      runId: "run-synthetic-1",
      historyNext: () => position.next,
      resumedGate: () => position.resumed,
      iteration: (id: string) => position.iterations?.[id] ?? 0,
      dispatch: async <T extends Record<string, unknown>>(stepId: string) => {
        dispatched.push(stepId);
        return partialFake<StepResult<T>>({ data: partialFake<T>({}) });
      },
    });
    const assisted = vi.fn<WorkflowContext["assisted"]>(async () => partialFake<Awaited<ReturnType<WorkflowContext["assisted"]>>>({ data: {} }));
    const run = { ctx, target: { repo: REPO, pr: 1 }, ownerGateReason: () => undefined };

    await packetTriggering(run, assisted)("approve-merge", gatePrompt);

    return { dispatched, assisted };
  }

  it("a replay whose recorded next step is this head's packet step replays it", async () => {
    const { dispatched, assisted } = await reachGate({ next: packetStep });

    expect(dispatched).toEqual([packetStep]);
    expect(assisted).toHaveBeenCalledOnce();
  });

  it("a replay whose recorded next step is something else records no packet step", async () => {
    const { dispatched, assisted } = await reachGate({ next: "sh-policy" });

    expect(dispatched).toEqual([]);
    expect(assisted).toHaveBeenCalledOnce();
  });

  it("a gate resumed from before the packet step existed spawns no packager", async () => {
    const { dispatched, assisted } = await reachGate({ resumed: "approve-merge" });

    expect(dispatched).toEqual([]);
    expect(assisted).toHaveBeenCalledOnce();
  });

  it("a fresh gate with nothing resumed records the packet step", async () => {
    const { dispatched } = await reachGate({});

    expect(dispatched).toEqual([packetStep]);
  });

  it("a second visual gate at a head that already has its packet step records no second one", async () => {
    const { dispatched, assisted } = await reachGate({ iterations: { [packetStep]: 1 } });

    expect(dispatched).toEqual([]);
    expect(assisted).toHaveBeenCalledOnce();
  });
});
