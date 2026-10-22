import type { AgentRow } from "@titan-design/agent-dispatch";
import { fakeGitHub, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened, outsideActions, spaceUpdates } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { configuredExitNotice, fallbackSeats, singleSeat, type NoticeFallbacks } from "./exit-notice.js";
import type { ShepherdPhases, Verdict } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { sweepSeatDigests, type SeatState } from "./seat-digest.js";
import type { SeatBook } from "./seats.js";
import { shepherdStoreRef, type RegistrationInput, type ShepherdStoreRef } from "./store.js";

const REPO_SEAT = "demo-coord";
const seatOf = (name: string): SeatBook["seats"][number] => ({ name, remotes: [REPO], paths: {}, grants: [] });
const BOOK: SeatBook = { seats: [seatOf(REPO_SEAT)], denied: [] };
const GONE = "no agent of impl-a's lineage is on the roster, so no checkout is known to start a successor in";
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function agentRow(name: string, spawnedBy: string): AgentRow {
  return { name, agentId: `${name}-id`, state: "exited", presence: "exited", status: "finished", profile: "implementer", surface: "headless", cwd: "/work", sessionId: "", spawnedBy, generation: 1 };
}

const liveRow = (name: string): AgentRow => ({ ...agentRow(name, "human"), state: "running", presence: "live", status: "running", generation: 2 });
const retiredRow = (name: string): AgentRow => ({ ...agentRow(name, "human"), status: "retired", generation: 2 });

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
type Registrant = Pick<RegistrationInput, "registrant"> & { successor?: string };

function register(store: ShepherdStoreRef, runId: string, { registrant, successor }: Registrant): void {
  const first = successor === undefined ? runId : `${runId}-died`;
  store.get().register({ repo: REPO, pr: 1, runId: first, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, registrant });
  if (successor === undefined) return;
  store.get().repoint(first, runId);
  store.get().update(runId, { task: "demo/1", implementer: successor, registrant: successor, policy: OWNER_GATE_POLICY });
}

/** A run red at H1 that no fixer takes, so Shepherd tries the ci-failed seat notice through the production ports. */
function startRed(registered: Registrant, roster?: readonly AgentRow[], book = BOOK, fallbacks: NoticeFallbacks = {}) {
  const fake = fakeGitHub();
  redAtH1(fake);
  let clock = 0;
  spaceUpdates(fake, (ms) => void (clock += ms));
  const store = shepherdStoreRef();
  const notices = agentChat(roster);
  const exitNotice = configuredExitNotice(() => book, notices, fallbacks, store);
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), exitNotice });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(unwoken)], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1 });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  register(store, runId, registered);
  return { host, store, fake, runId, notices, book };
}

/** A red run whose seat notice was sent, so it waits for a new head. */
async function redRun(registered: Registrant, roster?: readonly AgentRow[], fallbacks?: NoticeFallbacks) {
  const world = startRed(registered, roster, BOOK, fallbacks);
  await vi.waitFor(() => expect(world.host.runtime.status(world.runId)?.currentStep).toMatch(/^await-new-head/));
  return world;
}

/** What the run's sh-seat-notice step recorded. */
function noticeRecord(world: ReturnType<typeof startRed>): unknown {
  const run = world.host.runtime.status(world.runId)!;
  const notice = Object.values(run.stepResults).find((result) => result.stepId.startsWith("sh-seat-notice"));
  return (notice?.data as { result?: unknown } | undefined)?.result;
}

/** One digest sweep as serve runs it, over the same store, the production roster port and the config's fallback seats. */
async function digestSweep(world: ReturnType<typeof startRed>, roster?: readonly AgentRow[], fallbacks: NoticeFallbacks = {}, unreadable = false) {
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

async function digestSeats(world: ReturnType<typeof startRed>, roster?: readonly AgentRow[]): Promise<string[]> {
  return (await digestSweep(world, roster)).told;
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

  it("a run with no registrant sends its seat notice and digest to the repo's live seat, as before", async () => {
    const world = await redRun({});

    expect(world.notices.told).toEqual([REPO_SEAT]);
    expect(noticeRecord(world)).toMatchObject({ sent: true, seat: REPO_SEAT, detail: `told ${REPO_SEAT}` });
    expect(await digestSeats(world)).toEqual([REPO_SEAT]);
  });

  it("a run whose non-fixer registrant has retired sends its seat notice and digest to the repo's seat (TP-3958)", async () => {
    const roster = [retiredRow("tp-operator")];
    const world = await redRun({ registrant: "tp-operator" }, roster);

    expect(world.notices.told).toEqual([REPO_SEAT]);
    expect(await digestSeats(world, roster)).toEqual([REPO_SEAT]);
  });
});

describe("a seat notice for a seat with no live session goes to a configured fallback (TP-3958)", () => {
  const FALLBACKS: NoticeFallbacks = { redSeat: { repos: { [REPO.toUpperCase()]: "red-coord" }, fallback: "red-fallback" }, hubSeat: "hub-coord" };

  it("a retired repo seat's notice goes to the repo's red seat, and the record names the fallback", async () => {
    const world = await redRun({}, [retiredRow(REPO_SEAT), liveRow("red-coord"), liveRow("hub-coord")], FALLBACKS);

    expect(world.notices.told).toEqual(["red-coord"]);
    expect(noticeRecord(world)).toMatchObject({ sent: true, seat: "red-coord", detail: `told red-coord (${REPO_SEAT} holds no live session, so shepherd.redSeat.repos red-coord was told)` });
  });

  it("skips fallbacks with no live session, down to the hub seat", async () => {
    const world = await redRun({}, [retiredRow(REPO_SEAT), retiredRow("red-coord"), liveRow("hub-coord")], FALLBACKS);

    expect(world.notices.told).toEqual(["hub-coord"]);
    expect(noticeRecord(world)).toMatchObject({ detail: `told hub-coord (${REPO_SEAT} holds no live session, so shepherd.hubSeat hub-coord was told)` });
  });

  it("opens the owner gate, naming why, when neither the seat nor any fallback holds a live session", async () => {
    const world = startRed({}, [retiredRow(REPO_SEAT)], BOOK, FALLBACKS);

    await gateOpened(world.host, gateId(world.runId, "ci-failed"));

    expect(world.notices.told).toEqual([]);
    expect(noticeRecord(world)).toMatchObject({ sent: false, seat: REPO_SEAT, detail: `${REPO_SEAT} holds no live session and no fallback seat does` });
  });
});

describe("a seat digest for a seat with no live session goes where its notice goes (TP-4050)", () => {
  const FALLBACKS: NoticeFallbacks = { redSeat: { repos: { [REPO.toUpperCase()]: "red-coord" }, fallback: "red-fallback" }, hubSeat: "hub-coord" };

  it("a retired repo seat's digest goes to the repo's red seat", async () => {
    const roster = [retiredRow(REPO_SEAT), liveRow("red-coord"), liveRow("hub-coord")];
    const world = await redRun({}, roster, FALLBACKS);

    const sweep = await digestSweep(world, roster, FALLBACKS);

    expect(sweep).toMatchObject({ told: ["red-coord"], sent: ["red-coord"], failed: [] });
  });

  it("skips fallbacks with no live session, down to the hub seat", async () => {
    const roster = [retiredRow(REPO_SEAT), retiredRow("red-coord"), liveRow("hub-coord")];
    const world = await redRun({}, roster, FALLBACKS);

    expect((await digestSweep(world, roster, FALLBACKS)).told).toEqual(["hub-coord"]);
  });

  it("sends nothing and records why when neither the seat nor any fallback holds a live session", async () => {
    const roster = [retiredRow(REPO_SEAT)];
    const world = startRed({}, roster, BOOK, FALLBACKS);
    await gateOpened(world.host, gateId(world.runId, "ci-failed"));

    const sweep = await digestSweep(world, roster, FALLBACKS);

    expect(sweep).toMatchObject({ told: [], sent: [], failed: [{ seat: REPO_SEAT, cause: `${REPO_SEAT} holds no live session and no fallback seat does` }] });
  });

  it("keeps the repo's seat when the roster cannot be read, as for notices", async () => {
    const world = await redRun({});

    const sweep = await digestSweep(world, [retiredRow(REPO_SEAT), liveRow("hub-coord")], FALLBACKS, true);

    expect(sweep.told).toEqual([REPO_SEAT]);
  });
});

describe("a registrant never stands in for a repo no single seat owns: the owner gate opens (TP-3653)", () => {
  const books: Record<string, SeatBook> = {
    "deny-listed or charter hard-stopped": { ...BOOK, denied: [REPO.toLowerCase()] },
    unseated: { seats: [], denied: [] },
    "joined by several seats (`+`)": { seats: [seatOf(REPO_SEAT), seatOf("other-coord")], denied: [] },
  };

  it.each(Object.entries(books))("a repo %s opens ci-failed for the owner and sends neither notice nor digest", async (_name, book) => {
    const world = startRed({ registrant: "tp-operator" }, [], book);

    await gateOpened(world.host, gateId(world.runId, "ci-failed"));

    expect(world.notices.told).toEqual([]);
    expect(await digestSeats(world)).toEqual([]);
  });

  it("a fixer-registered run in a deny-listed repo opens the owner gate rather than telling its spawner", async () => {
    const roster = [agentRow("impl-a", "tp-operator")];
    const world = startRed({ registrant: "impl-a" }, roster, { ...BOOK, denied: [REPO.toLowerCase()] });

    await gateOpened(world.host, gateId(world.runId, "ci-failed"));

    expect(world.notices.told).toEqual([]);
    expect(await digestSeats(world, roster)).toEqual([]);
  });
});
