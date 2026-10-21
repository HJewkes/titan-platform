import type { AgentRow } from "@titan-design/agent-dispatch";
import { fakeGitHub, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, outsideActions, spaceUpdates } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { configuredExitNotice } from "./exit-notice.js";
import type { ShepherdPhases, Verdict } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { sweepSeatDigests, type SeatState } from "./seat-digest.js";
import type { SeatBook } from "./seats.js";
import { shepherdStoreRef, type RegistrationInput, type ShepherdStoreRef } from "./store.js";

const REPO_SEAT = "demo-coord";
const BOOK: SeatBook = { seats: [{ name: REPO_SEAT, remotes: [REPO], paths: {}, grants: [] }], denied: [] };
const GONE = "no agent of impl-a's lineage is on the roster, so no checkout is known to start a successor in";
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function agentRow(name: string, spawnedBy: string): AgentRow {
  return { name, agentId: `${name}-id`, state: "exited", presence: "exited", status: "finished", profile: "implementer", surface: "headless", cwd: "/work", sessionId: "", spawnedBy, generation: 1 };
}

/** The agent-chat the production ports talk to: a fixed roster, and every message's recipient. */
function agentChat(roster: readonly AgentRow[] = []) {
  const told: string[] = [];
  return { told, roster: async () => roster, message: async (name: string) => void told.push(name) };
}

const merge = (headSha: string): Verdict => ({ kind: "MERGE", headSha, evidence: {} });
const unwoken: ShepherdPhases = { wake: async () => ({ kind: "unhandled", reason: GONE }), review: async (_ctx, request) => merge(request.headSha) };
const redAtH1 = (fake: FakeGitHub) => (fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [outsideActions(successRun("validate", 1, undefined, pr.headSha === H1 ? "failure" : "success")), successRun("dag-check", 2)]));

/** `successor` registers first on a run that died, which Shepherd restarts as this one; the successor then registers the PR again. */
type Registrant = Pick<RegistrationInput, "registrant"> & { successor?: string };

function register(store: ShepherdStoreRef, runId: string, { registrant, successor }: Registrant): void {
  const first = successor === undefined ? runId : `${runId}-died`;
  store.get().register({ repo: REPO, pr: 1, runId: first, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, registrant });
  if (successor === undefined) return;
  store.get().repoint(first, runId);
  store.get().update(runId, { task: "demo/1", implementer: successor, registrant: successor, policy: OWNER_GATE_POLICY });
}

/** A run red at H1 that no fixer takes, so Shepherd sends the ci-failed seat notice through the production ports. */
async function redRun(registered: Registrant, roster?: readonly AgentRow[]) {
  const fake = fakeGitHub();
  redAtH1(fake);
  let clock = 0;
  spaceUpdates(fake, (ms) => void (clock += ms));
  const store = shepherdStoreRef();
  const notices = agentChat(roster);
  const exitNotice = configuredExitNotice(() => BOOK, notices, undefined, store);
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), exitNotice });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(unwoken)], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1 });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  register(store, runId, registered);
  await vi.waitFor(() => expect(host.runtime.status(runId)?.currentStep).toMatch(/^await-new-head/));
  return { host, store, fake, runId, notices };
}

/** One digest sweep as serve runs it, over the same store and the production roster port. */
async function digestSeats(world: Awaited<ReturnType<typeof redRun>>, roster?: readonly AgentRow[]): Promise<string[]> {
  const digests = agentChat(roster);
  const states = new Map<string, SeatState>();
  const services = { store: world.store, port: githubPort(world.fake.wire), seats: () => BOOK };
  const ports = { seatLookup: () => (repo: string) => (repo === REPO ? REPO_SEAT : undefined), roster: digests.roster, send: (seat: string) => digests.message(seat) };
  await sweepSeatDigests(world.host, services, ports, { get: (seat) => states.get(seat), set: (seat, state) => void states.set(seat, state) });
  return digests.told;
}

describe("Shepherd's seat notice and digest follow the run's registrant, not the repo's seat (TP-3653)", () => {
  it("a run tp-operator registered sends its seat notice and its digest to tp-operator only", async () => {
    const world = await redRun({ registrant: "tp-operator" });

    expect(world.notices.told).toEqual(["tp-operator"]);
    expect(await digestSeats(world)).toEqual(["tp-operator"]);
  });

  it("a fixer that registered its own PR has its notices sent to the session that spawned it", async () => {
    const roster = [agentRow("impl-a", "tp-operator")];
    const world = await redRun({ registrant: "impl-a" }, roster);

    expect(world.notices.told).toEqual(["tp-operator"]);
    expect(await digestSeats(world, roster)).toEqual(["tp-operator"]);
  });

  it("a restarted successor run keeps the original registrant when the successor registers the PR again", async () => {
    const world = await redRun({ registrant: "tp-operator", successor: "impl-a-s1" });

    expect(world.store.get().byRun(world.runId)?.registrant).toEqual({ name: "tp-operator", fixer: false });
    expect(world.notices.told).toEqual(["tp-operator"]);
    expect(await digestSeats(world)).toEqual(["tp-operator"]);
  });

  it("a restarted successor of a fixer that registered its own PR still sends to the session that spawned that fixer", async () => {
    const roster = [agentRow("impl-a", "tp-operator"), agentRow("impl-a-next", "human")];
    const world = await redRun({ registrant: "impl-a", successor: "impl-a-next" }, roster);

    expect(world.notices.told).toEqual(["tp-operator"]);
    expect(await digestSeats(world, roster)).toEqual(["tp-operator"]);
  });

  it("a run with no registrant sends its seat notice and digest to the repo's seat, as before", async () => {
    const world = await redRun({});

    expect(world.notices.told).toEqual([REPO_SEAT]);
    expect(await digestSeats(world)).toEqual([REPO_SEAT]);
  });
});
