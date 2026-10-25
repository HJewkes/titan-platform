import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { SeatDigestPacingSchema, digestPacer, type DigestPacer } from "./seat-digest-pace.js";
import { sendSeatDigests, type DigestInput, type SeatDigestMemory, type SeatDigestPorts, type SeatState } from "./seat-digest.js";
import type { WatchRow } from "./view.js";

const START = Date.parse("2026-10-10T00:00:00.000Z");
const MINUTE = 60_000;
const PACING = SeatDigestPacingSchema.parse({});

function row(n: number, extra: Partial<WatchRow> = {}): WatchRow {
  return { repo: "acme/widgets", pr: n, branch: `feat/${n}`, runId: `run-${n}`, task: `demo/T-${n}`, phase: "ci", headSha: "a".repeat(40), phaseSince: "2026-10-10T00:00:00.000Z", nextAction: "waiting for CI", pendingGate: null, held: null, stalled: null, outcome: null, ...extra };
}

function run(id: string, done = false): WorkflowRun {
  return { id, workflowName: "shepherd-pr", params: {}, status: done ? "completed" : "running", currentStep: done ? null : "ci-wait:0", stepResults: {}, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: "2026-10-10T00:00:00.000Z", completedAt: null, error: null };
}

const gated = (n: number, stepId = "main-red-again"): DigestInput => ({ row: row(n, { phase: "awaiting-approval", pendingGate: { gateId: `run-${n}/${stepId}`, stepId, since: "2026-10-10T00:00:00.000Z" } }), run: run(`run-${n}`) });
/** An open run with nothing to report, so a seat's first sweep writes its memory and later merges read as news. */
const idle: DigestInput = { row: row(100), run: run("run-100") };
const merged = (n: number): DigestInput => ({ row: row(n, { phase: "done", outcome: { kind: "merged", reason: null } }), run: run(`run-${n}`, true) });

function harness(pacer: DigestPacer = digestPacer(PACING)) {
  const sent: { at: number; text: string }[] = [];
  const states = new Map<string, SeatState>();
  const memory: SeatDigestMemory = { get: (seat) => states.get(seat), set: (seat, state) => void states.set(seat, state) };
  const ports = (at: number): SeatDigestPorts => ({ seatLookup: () => () => "widgets-coord", send: async (_seat, text) => void sent.push({ at, text }) });
  const sweep = (inputs: DigestInput[], at: number, by: DigestPacer = pacer) => sendSeatDigests(inputs, ports(at), memory, {}, new Date(at), by);
  return { sent, memory, sweep };
}

/** The runs open at minute `m`: each run joins the sweep inputs from its minute on. */
const arrivals = (events: [minute: number, input: DigestInput][]) => (m: number): DigestInput[] => events.filter(([at]) => at <= m).map(([, input]) => input).concat(idle);

describe("seat digest pacing", () => {
  it("gives 12 gates that open within 60 s one digest, once the first has settled", async () => {
    const { sent, sweep } = harness();
    const gates = Array.from({ length: 12 }, (_, i) => ({ at: START + i * 5_000, input: gated(i + 1) }));

    for (let at = START; at <= START + 10 * MINUTE; at += MINUTE) await sweep(gates.filter((g) => g.at <= at).map((g) => g.input), at);

    expect(sent.map((m) => m.at)).toEqual([START + 2 * MINUTE]);
    expect(sent[0]!.text).toMatch(/^Shepherd digest for widgets-coord: 12 open,/);
  });

  it("gives 5 merges over 25 minutes one digest, 30 minutes after the first", async () => {
    const { sent, sweep } = harness();
    const open = [0, 5, 10, 15, 25].map((m, i): [number, DigestInput] => [m, merged(i + 1)]);
    const inputs = arrivals(open);
    await sweep([idle], START - MINUTE);

    for (let m = 0; m <= 40; m += 1) await sweep(inputs(m), START + m * MINUTE);

    expect(sent.map((s) => s.at)).toEqual([START + 30 * MINUTE]);
    for (const n of [1, 2, 3, 4, 5]) expect(sent[0]!.text).toContain(`acme/widgets#${n} merged`);
  });

  it("carries the merges held so far on the digest a new gate brings", async () => {
    const { sent, sweep } = harness();
    const inputs = arrivals([[0, merged(1)], [5, merged(2)], [10, merged(3)], [12, gated(9, "approve-merge")]]);
    await sweep([idle], START - MINUTE);

    for (let m = 0; m <= 20; m += 1) await sweep(inputs(m), START + m * MINUTE);

    expect(sent.map((s) => s.at)).toEqual([START + 14 * MINUTE]);
    expect(sent[0]!.text).toContain("New:\n- acme/widgets#9 waits on approve-merge");
    expect(sent[0]!.text).toContain("Finished:\n- acme/widgets#1 merged\n- acme/widgets#2 merged\n- acme/widgets#3 merged");
  });

  it("sends a full batch at once, before its flush time", async () => {
    const { sent, sweep } = harness(digestPacer({ ...PACING, maxBatch: 3 }));
    await sweep([idle], START - MINUTE);

    await sweep([idle, merged(1), merged(2)], START);
    await sweep([idle, merged(1), merged(2), merged(3)], START + MINUTE);

    expect(sent.map((s) => s.at)).toEqual([START + MINUTE]);
  });

  it("keeps a held item unsent in memory, so after a restart a fresh pacer still sends it", async () => {
    const { sent, sweep } = harness();
    const inputs = [gated(1, "approve-merge")];
    await sweep(inputs, START);

    const restarted = digestPacer(PACING);
    await sweep(inputs, START + MINUTE, restarted);
    await sweep(inputs, START + 3 * MINUTE, restarted);

    expect(sent.map((s) => s.at)).toEqual([START + 3 * MINUTE]);
    expect(sent[0]!.text).toContain("acme/widgets#1 waits on approve-merge");
  });

  it("takes the task's defaults when pacing names no values, and rejects an unknown key", () => {
    expect(PACING).toEqual({ settleMs: 120_000, flushMs: 1_800_000, maxBatch: 20 });
    expect(SeatDigestPacingSchema.safeParse({ settleMS: 1 }).success).toBe(false);
  });
});
