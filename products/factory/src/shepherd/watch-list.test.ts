import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { SeatDigestPacingSchema, digestPacer } from "./seat-digest-pace.js";
import { sendSeatDigests, type DigestInput, type SeatDigestMemory, type SeatDigestPorts, type SeatState } from "./seat-digest.js";
import type { WatchRow } from "./view.js";
import { digestWatches, watchListMigration, watchListTable, watchedSeat, type DigestWatches, type PrWatch, type WatchEvent } from "./watch-list.js";

const START = Date.parse("2026-10-10T00:00:00.000Z");
const MINUTE = 60_000;
const PACING = SeatDigestPacingSchema.parse({});

function row(n: number, extra: Partial<WatchRow> = {}): WatchRow {
  return { repo: "acme/widgets", pr: n, branch: `feat/${n}`, runId: `run-${n}`, task: `demo/T-${n}`, phase: "ci", headSha: "a".repeat(40), phaseSince: "2026-10-10T00:00:00.000Z", nextAction: "waiting for CI", pendingGate: null, held: null, stalled: null, outcome: null, ...extra };
}

function run(id: string, done = false): WorkflowRun {
  return { id, workflowName: "shepherd-pr", params: {}, status: done ? "completed" : "running", currentStep: done ? null : "ci-wait:0", stepResults: {}, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: "2026-10-10T00:00:00.000Z", completedAt: null, error: null };
}

const idle: DigestInput = { row: row(100), run: run("run-100") };
const merged = (n: number): DigestInput => ({ row: row(n, { phase: "done", outcome: { kind: "merged", reason: null } }), run: run(`run-${n}`, true) });

/** An in-memory watch list keyed by run id, standing in for the store's table. */
function watchList(entries: Record<string, WatchEvent[]>, seat: string | null = null): DigestWatches & { left: () => string[] } {
  const watches = new Map(Object.entries(entries).map(([runId, on]): [string, PrWatch] => [runId, { repo: "acme/widgets", pr: Number(runId.slice(4)), seat, on, actor: "widgets-coord", at: "2026-10-10T00:00:00.000Z" }]));
  return { of: (runId) => watches.get(runId), drop: (runIds) => runIds.forEach((runId) => watches.delete(runId)), left: () => [...watches.keys()] };
}

function harness(watches: DigestWatches, failing = false) {
  const sent: { at: number; text: string }[] = [];
  const states = new Map<string, SeatState>();
  const memory: SeatDigestMemory = { get: (seat) => states.get(seat), set: (seat, state) => void states.set(seat, state) };
  const pacer = digestPacer(PACING);
  const ports = (at: number): SeatDigestPorts => ({
    seatLookup: () => () => "widgets-coord",
    send: async (_seat, text) => {
      if (failing) throw new Error("broker down");
      sent.push({ at, text });
    },
  });
  const sweep = (inputs: DigestInput[], at: number) => sendSeatDigests(inputs, ports(at), memory, { watches }, new Date(at), pacer);
  return { sent, sweep };
}

/** Sweeps once a minute from minute 0 to `last`, with `inputs` open throughout, after a first sweep that knows only `idle`. */
async function minutes(sweep: ReturnType<typeof harness>["sweep"], inputs: DigestInput[], last: number): Promise<void> {
  await sweep([idle], START - MINUTE);
  for (let m = 0; m <= last; m += 1) await sweep([idle, ...inputs], START + m * MINUTE);
}

describe("watched runs in the seat digest", () => {
  it("sends a watched run's merge once it settles, not at the 30-minute batch flush", async () => {
    const watches = watchList({ "run-1": ["merged", "stopped", "gated"] });
    const { sent, sweep } = harness(watches);

    await minutes(sweep, [merged(1)], 40);

    expect(sent.map((s) => s.at)).toEqual([START + 2 * MINUTE]);
    expect(sent[0]!.text).toContain("acme/widgets#1 merged");
  });

  it("carries an unwatched merge along on the digest a watched merge brings", async () => {
    const { sent, sweep } = harness(watchList({ "run-1": ["merged"] }));

    await minutes(sweep, [merged(1), merged(2)], 40);

    expect(sent.map((s) => s.at)).toEqual([START + 2 * MINUTE]);
    expect(sent[0]!.text).toContain("- acme/widgets#1 merged\n- acme/widgets#2 merged");
  });

  it("leaves a merge on the batch flush when the watch names only gated", async () => {
    const { sent, sweep } = harness(watchList({ "run-1": ["gated"] }));

    await minutes(sweep, [merged(1)], 40);

    expect(sent.map((s) => s.at)).toEqual([START + 30 * MINUTE]);
  });

  it("keeps the watch while the digest is held, and drops it once the digest that reports the merge is sent", async () => {
    const watches = watchList({ "run-1": ["merged"] });
    const { sweep } = harness(watches);
    await sweep([idle], START - MINUTE);

    await sweep([idle, merged(1)], START + MINUTE);
    const whileHeld = watches.left();
    await sweep([idle, merged(1)], START + 3 * MINUTE);

    expect(whileHeld).toEqual(["run-1"]);
    expect(watches.left()).toEqual([]);
  });

  it("keeps the watch when the digest could not be sent, so the next sweep reports the merge again", async () => {
    const watches = watchList({ "run-1": ["merged"] });
    const { sweep } = harness(watches, true);

    await minutes(sweep, [merged(1)], 5);

    expect(watches.left()).toEqual(["run-1"]);
  });

  it("routes a watched run to the seat its watch names, and any other run as before", () => {
    const seatOf = watchedSeat(() => "widgets-coord", watchList({ "run-1": ["merged"] }, "ops-coord"));

    expect([seatOf({ runId: "run-1" }), seatOf({ runId: "run-2" })]).toEqual(["ops-coord", "widgets-coord"]);
  });
});

describe("watch list table", () => {
  it("follows the PR's current run, and a drop clears the stored watch", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [watchListMigration(41)]);
    const table = watchListTable(db, () => "2026-10-10T00:00:00.000Z");
    table.set({ repo: "Acme/Widgets", pr: 1, seat: null, on: ["merged"], actor: "widgets-coord" });
    const current = { runId: "run-1b" };
    const watches = digestWatches({ watches: () => table, byPr: (repo, pr) => (repo === "acme/widgets" && pr === 1 ? current : undefined) });

    const followed = [watches.of("run-1"), watches.of("run-1b")?.pr];
    watches.drop(["run-1b"]);

    expect(followed).toEqual([undefined, 1]);
    expect(table.list()).toEqual([]);
  });
});
