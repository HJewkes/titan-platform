import type { AgentRow } from "@titan-design/agent-dispatch";
import { fakeGitHub, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { expect, onTestFinished, vi } from "vitest";
import { openFactoryHost } from "../host.js";
import { configuredExitNotice, fallbackSeats, singleSeat, type NoticeFallbacks } from "../shepherd/exit-notice.js";
import type { ShepherdPhases, Verdict } from "../shepherd/phases.js";
import { OWNER_GATE_POLICY } from "../shepherd/policy.js";
import { shepherdPrWorkflow } from "../shepherd/pr.js";
import { sweepSeatDigests, type SeatState } from "../shepherd/seat-digest.js";
import type { SeatBook } from "../shepherd/seats.js";
import { shepherdStoreRef, type RegistrationInput, type ShepherdStoreRef } from "../shepherd/store.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { H1, REPO, outsideActions, spaceUpdates } from "./land.js";

export const REPO_SEAT = "demo-coord";
export const seatOf = (name: string): SeatBook["seats"][number] => ({ name, remotes: [REPO], paths: {}, grants: [] });
export const BOOK: SeatBook = { seats: [seatOf(REPO_SEAT)], denied: [] };
const GONE = "no agent of impl-a's lineage is on the roster, so no checkout is known to start a successor in";

export function agentRow(name: string, spawnedBy: string): AgentRow {
  return { name, agentId: `${name}-id`, state: "exited", presence: "exited", status: "finished", profile: "implementer", surface: "headless", cwd: "/work", sessionId: "", spawnedBy, generation: 1 };
}

export const liveRow = (name: string): AgentRow => ({ ...agentRow(name, "human"), state: "running", presence: "live", status: "running", generation: 2 });
export const retiredRow = (name: string): AgentRow => ({ ...agentRow(name, "human"), status: "retired", generation: 2 });

/** The seats that hold a live session unless a test's own rows retire them; a later generation wins. */
const LIVE_SEATS = [REPO_SEAT, "tp-operator"].map((name) => ({ ...liveRow(name), generation: 1 }));

/** The agent-chat the production ports talk to: a fixed roster, and every message's recipient. */
function agentChat(roster: readonly AgentRow[] = []) {
  const told: string[] = [];
  return { told, roster: async () => [...LIVE_SEATS, ...roster], message: async (name: string) => void told.push(name) };
}

const merge = (headSha: string): Verdict => ({ kind: "MERGE", headSha, evidence: {} });
const unwoken: ShepherdPhases = { wake: async () => ({ kind: "unhandled", reason: GONE }), review: async (_ctx, request) => merge(request.headSha) };
const redAtH1 = (fake: FakeGitHub) => (fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [outsideActions(successRun("validate", 1, undefined, pr.headSha === H1 ? "failure" : "success")), successRun("dag-check", 2)]));

/** `successor` registers first on a run that died, which Shepherd restarts as this one; the successor then registers the PR again. */
export type Registrant = Pick<RegistrationInput, "registrant"> & { successor?: string };

function register(store: ShepherdStoreRef, runId: string, { registrant, successor }: Registrant): void {
  const first = successor === undefined ? runId : `${runId}-died`;
  store.get().register({ repo: REPO, pr: 1, runId: first, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, registrant });
  if (successor === undefined) return;
  store.get().repoint(first, runId);
  store.get().update(runId, { task: "demo/1", implementer: successor, registrant: successor, policy: OWNER_GATE_POLICY });
}

/** A run red at H1 that no fixer takes, so Shepherd tries the ci-failed seat notice through the production ports. */
export function startRed(registered: Registrant, roster?: readonly AgentRow[], book = BOOK, fallbacks: NoticeFallbacks = {}) {
  const fake = fakeGitHub();
  redAtH1(fake);
  let clock = 0;
  spaceUpdates(fake, (ms) => void (clock += ms));
  const store = shepherdStoreRef();
  const notices = agentChat(roster);
  const exitNotice = configuredExitNotice(() => book, notices, fallbacks, store);
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), exitNotice });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(unwoken)], routes, gatePollMs: 5 });
  onTestFinished(() => host.close());
  fake.addPr({ headSha: H1 });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  register(store, runId, registered);
  return { host, store, fake, runId, notices, book };
}

export type RedWorld = ReturnType<typeof startRed>;

/** A red run whose seat notice was sent, so it waits for a new head. */
export async function redRun(registered: Registrant, roster?: readonly AgentRow[], fallbacks?: NoticeFallbacks): Promise<RedWorld> {
  const world = startRed(registered, roster, BOOK, fallbacks);
  await vi.waitFor(() => expect(world.host.runtime.status(world.runId)?.currentStep).toMatch(/^await-new-head/));
  return world;
}

/** One digest sweep as serve runs it, over the same store, the production roster port and the config's fallback seats. */
export async function digestSweep(world: RedWorld, roster?: readonly AgentRow[], fallbacks: NoticeFallbacks = {}, unreadable = false) {
  const digests = agentChat(roster);
  const states = new Map<string, SeatState>();
  const services = { store: world.store, port: githubPort(world.fake.wire), seats: () => world.book };
  const ports = {
    seatLookup: () => (repo: string) => singleSeat(world.book, repo),
    roster: unreadable ? async () => Promise.reject(new Error("broker down")) : digests.roster,
    fallbackSeats: (repo: string) => fallbackSeats(fallbacks, repo),
    send: (seat: string) => digests.message(seat),
  };
  const result = await sweepSeatDigests(world.host, services, ports, { get: (seat) => states.get(seat), set: (seat, state) => void states.set(seat, state) });
  return { told: digests.told, ...result };
}
