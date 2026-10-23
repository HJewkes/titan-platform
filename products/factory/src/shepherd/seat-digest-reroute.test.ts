import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it, vi } from "vitest";
import { REPO } from "../test-support/land.js";
import { REPO_SEAT, digestSweep, liveRow, redRun, retiredRow, type RedWorld } from "../test-support/registrant-routing.js";
import type { NoticeFallbacks } from "./exit-notice.js";
import { digestReads, sendSeatDigests, type DigestInput, type SeatDigestMemory, type SeatDigestPorts, type SeatState } from "./seat-digest.js";
import type { WatchRow } from "./view.js";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const HOURS_AGO = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const DEAD = "old-coord";
const FALLBACK = "hub-coord";

function row(n: number, extra: Partial<WatchRow> = {}): WatchRow {
  return { repo: "acme/widgets", pr: n, branch: `feat/${n}`, runId: `run-${n}`, task: `demo/T-${n}`, phase: "ci", headSha: "a".repeat(40), phaseSince: HOURS_AGO(1), nextAction: "waiting for CI", pendingGate: null, held: null, stalled: null, outcome: null, ...extra };
}

function run(id: string, completedAt: string | null = null): WorkflowRun {
  return { id, workflowName: "shepherd-pr", params: {}, status: completedAt === null ? "running" : "completed", currentStep: completedAt === null ? "ci-wait:0" : null, stepResults: {}, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: HOURS_AGO(200), completedAt, error: null };
}

const finished = (n: number, hoursAgo: number): DigestInput => ({ row: row(n, { phase: "done", phaseSince: HOURS_AGO(hoursAgo), outcome: { kind: "merged", reason: null } }), run: run(`run-${n}`, HOURS_AGO(hoursAgo)) });
const gated = (n: number): DigestInput => ({ row: row(n, { phase: "awaiting-approval", pendingGate: { gateId: `run-${n}/approve-merge`, stepId: "approve-merge", since: HOURS_AGO(1) } }), run: run(`run-${n}`) });

function ports(): SeatDigestPorts & { sent: { seat: string; text: string }[] } {
  const sent: { seat: string; text: string }[] = [];
  return { sent, seatLookup: () => () => DEAD, send: async (seat, text) => void sent.push({ seat, text }) };
}

function memoryOf(initial: Record<string, SeatState>): SeatDigestMemory {
  const states = new Map(Object.entries(initial));
  return { get: (seat) => states.get(seat), set: (seat, state) => void states.set(seat, state) };
}

const toFallback = { seatOf: () => FALLBACK, reroutedFrom: () => DEAD };
const backlog = (count: number): DigestInput[] => Array.from({ length: count }, (_, i) => finished(1000 + i, 72));

describe("a digest rerouted from a dead seat carries only what is recent and unheard (TP-4059)", () => {
  it("lists only the finished runs inside the window, not the dead seat's whole backlog", async () => {
    const out = ports();
    const memory = memoryOf({ [FALLBACK]: { open: [], finished: [] } });

    await sendSeatDigests([...backlog(2500), finished(1, 2), finished(2, 3), finished(3, 4)], out, memory, toFallback, NOW);

    expect(out.sent).toHaveLength(1);
    expect(out.sent[0]!.text).toBe(["Shepherd digest for hub-coord: 0 open, 3 newly finished.", "Open: none.", "Finished:", "- acme/widgets#1 merged", "- acme/widgets#2 merged", "- acme/widgets#3 merged"].join("\n"));
  });

  it("starts the window at the dead seat's last digest when that is under 24 h ago", async () => {
    const out = ports();
    const memory = memoryOf({ [FALLBACK]: { open: [], finished: [] }, [DEAD]: { open: [], finished: [], at: HOURS_AGO(3) } });

    await sendSeatDigests([finished(1, 2), finished(2, 4)], out, memory, toFallback, NOW);

    expect(out.sent[0]!.text).toMatch(/1 newly finished\.[\s\S]*#1 merged$/);
  });

  it("sends a live seat's digest exactly as before, with no window", async () => {
    const out = ports();
    const memory = memoryOf({ [DEAD]: { open: [], finished: [] } });

    await sendSeatDigests([gated(1), finished(2, 72)], out, memory, { seatOf: () => DEAD }, NOW);

    expect(out.sent).toEqual([
      { seat: DEAD, text: ["Shepherd digest for old-coord: 1 open, 1 newly finished.", "Open:", "- acme/widgets#1 waits on approve-merge: `titan-factory gate resolve run-1 approve-merge --json '<payload>'`", "Finished:", "- acme/widgets#2 merged"].join("\n") },
    ]);
  });

  it("settles the old rows, so a second sweep neither sends nor reads them again", async () => {
    const out = ports();
    const memory = memoryOf({ [FALLBACK]: { open: [], finished: [] } });
    const inputs = [...backlog(5), finished(1, 2)];
    await sendSeatDigests(inputs, out, memory, toFallback, NOW);

    await sendSeatDigests(inputs, out, memory, toFallback, NOW);

    expect(out.sent).toHaveLength(1);
    expect(inputs.filter((input) => digestReads(memory, toFallback.seatOf)(input.row, true))).toEqual([]);
  });
});

describe("a rerouted digest through the sweep serve runs (TP-4059)", () => {
  const FALLBACKS: NoticeFallbacks = { redSeat: { repos: { [REPO.toUpperCase()]: "red-coord" }, fallback: "red-fallback" } };
  const ROSTER = [retiredRow(REPO_SEAT), liveRow("red-coord")];
  const knownFallback = (): Map<string, SeatState> => new Map([["red-coord", { open: [], finished: [] }]]);

  async function closedRun(): Promise<RedWorld> {
    const world = await redRun({}, ROSTER, FALLBACKS);
    await world.fake.wire.closePr(REPO, 1);
    await vi.waitFor(() => expect(world.host.runtime.status(world.runId)?.completedAt).not.toBeNull(), { timeout: 10_000 });
    return world;
  }

  it("tells the fallback of the retired seat's run that finished inside the window", async () => {
    const world = await closedRun();

    const sweep = await digestSweep(world, ROSTER, FALLBACKS, false, { states: knownFallback() });

    expect(sweep.told).toEqual(["red-coord"]);
    expect(sweep.texts[0]).toContain(`${REPO}#1 stopped`);
  });

  it("settles the retired seat's run that finished before the window, telling the fallback nothing", async () => {
    const world = await closedRun();
    const states = knownFallback();

    const sweep = await digestSweep(world, ROSTER, FALLBACKS, false, { states, now: new Date(Date.now() + 48 * 3_600_000) });

    expect(sweep.told).toEqual([]);
    expect(states.get("red-coord")?.finished).toContain(world.runId);
  });
});
