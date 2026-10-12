import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { digestReads, fileSeatDigestMemory, sendSeatDigests, type DigestInput, type SeatDigestMemory, type SeatDigestPorts, type SeatState } from "./seat-digest.js";
import type { WatchRow } from "./view.js";

const HEAD = "a".repeat(40);
const SEATS: Record<string, string> = { "acme/widgets": "widgets-coord", "acme/gears": "gears-coord" };

function row(n: number, extra: Partial<WatchRow> = {}, repo = "acme/widgets"): WatchRow {
  return {
    repo,
    pr: n,
    branch: `feat/${n}`,
    runId: `run-${n}`,
    task: `demo/T-${n}`,
    phase: "ci",
    headSha: HEAD,
    phaseSince: "2026-10-10T00:00:00.000Z",
    nextAction: "waiting for CI",
    pendingGate: null,
    held: null,
    stalled: null,
    outcome: null,
    ...extra,
  };
}

function run(id: string, currentStep: string | null = "ci-wait:0", notice?: object): WorkflowRun {
  const stepResults: Record<string, StepResult> = notice ? { "sh-seat-notice#0": { stepId: "sh-seat-notice", iteration: 0, agentId: null, signal: null, completedAt: "2026-10-10T00:01:00.000Z", data: { result: notice } } } : {};
  const status = currentStep === null ? "completed" : "running";
  return { id, workflowName: "shepherd-pr", params: {}, status, currentStep, stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: "2026-10-10T00:00:00.000Z", completedAt: null, error: null };
}

const plain = (r: WatchRow): DigestInput => ({ row: r, run: run(r.runId) });
const gated = (n: number, stepId: string, repo?: string): DigestInput => plain(row(n, { phase: "awaiting-approval", pendingGate: { gateId: `run-${n}/${stepId}`, stepId, since: "2026-10-10T00:00:00.000Z" } }, repo));
const finished = (n: number, outcome: WatchRow["outcome"]): DigestInput => ({ row: row(n, { phase: "done", outcome }), run: run(`run-${n}`, null) });

function fakePorts(failFor: ReadonlySet<string> = new Set()): SeatDigestPorts & { sent: { seat: string; text: string }[] } {
  const sent: { seat: string; text: string }[] = [];
  return {
    sent,
    seatLookup: () => (repo) => SEATS[repo],
    send: async (seat, text) => {
      if (failFor.has(seat)) throw new Error("broker down");
      sent.push({ seat, text });
    },
  };
}

function memoryMap(): SeatDigestMemory {
  const states = new Map<string, SeatState>();
  return { get: (seat) => states.get(seat), set: (seat, state) => void states.set(seat, state) };
}

describe("digest reads", () => {
  const seatFor = (repo: string): string | undefined => SEATS[repo];
  const reads = (memory: SeatDigestMemory) => (input: DigestInput): boolean => digestReads(memory, seatFor)(input.row.repo, input.row.runId, input.run.status === "completed");

  it("reads every run of a seat with no memory, then only its unfinished runs and finished runs it has not heard of", async () => {
    const memory = memoryMap();
    const merged = finished(1, { kind: "merged", reason: null });
    const settledWithoutOutcome = finished(2, null);
    await sendSeatDigests([merged, settledWithoutOutcome].filter(reads(memory)), fakePorts(), memory);

    const later = [merged, settledWithoutOutcome, plain(row(3)), finished(4, { kind: "merged", reason: null })];

    expect(later.filter(reads(memory)).map((input) => input.row.runId)).toEqual(["run-3", "run-4"]);
  });

  it("reports a finished run once even though later sweeps no longer read it", async () => {
    const ports = fakePorts();
    const memory = memoryMap();
    const sweep = (inputs: DigestInput[]) => sendSeatDigests(inputs.filter(reads(memory)), ports, memory);
    await sweep([plain(row(1))]);

    for (let n = 0; n < 3; n += 1) await sweep([plain(row(1)), finished(2, { kind: "merged", reason: null })]);

    expect(ports.sent.map((message) => message.text.includes("acme/widgets#2 merged"))).toEqual([true]);
  });

  it("reads nothing for a repo no single seat owns", () => {
    expect(reads(memoryMap())(plain(row(1, {}, "acme/orphan")))).toBe(false);
  });
});

describe("seat digests", () => {
  it("sends one message per seat when a gate opens, carrying the exact gate resolve command", async () => {
    const ports = fakePorts();

    await sendSeatDigests([gated(1, "approve-merge:2"), gated(2, "ci-failed"), gated(3, "approve-merge", "acme/gears")], ports, memoryMap());

    expect(ports.sent.map((m) => m.seat).sort()).toEqual(["gears-coord", "widgets-coord"]);
    const widgets = ports.sent.find((m) => m.seat === "widgets-coord")!.text;
    expect(widgets).toContain("titan-factory gate resolve run-1 approve-merge:2 --json '<payload>'");
    expect(widgets).toContain("titan-factory gate resolve run-2 ci-failed --json '<payload>'");
    expect(widgets).toMatch(/^Shepherd digest for widgets-coord: 2 open, 0 newly finished\./);
  });

  it("sends nothing when the state is unchanged since the last digest", async () => {
    const ports = fakePorts();
    const memory = memoryMap();
    const inputs = [gated(1, "approve-merge"), plain(row(2))];

    await sendSeatDigests(inputs, ports, memory);
    await sendSeatDigests(inputs, ports, memory);
    await sendSeatDigests([...inputs].reverse(), ports, memory);

    expect(ports.sent).toHaveLength(1);
  });

  it("sends one more message for each later change: a new gate, then the gate clearing", async () => {
    const ports = fakePorts();
    const memory = memoryMap();

    await sendSeatDigests([gated(1, "approve-merge")], ports, memory);
    await sendSeatDigests([gated(1, "approve-merge"), gated(2, "sh-sent-back")], ports, memory);
    await sendSeatDigests([plain(row(1)), plain(row(2))], ports, memory);

    expect(ports.sent).toHaveLength(3);
    expect(ports.sent[2]!.text).toContain("Open: none.");
  });

  it("names a told ci-failed fix round with no wake, and drops it once the head moves", async () => {
    const ports = fakePorts();
    const memory = memoryMap();
    const told = { row: row(4), run: run("run-4", "await-new-head:0", { sent: true, seat: "widgets-coord", gate: "ci-failed", headSha: HEAD, detail: "told widgets-coord" }) };

    await sendSeatDigests([told], ports, memory);
    await sendSeatDigests([{ ...told, row: row(4, { headSha: "b".repeat(40) }) }], ports, memory);

    expect(ports.sent).toHaveLength(2);
    expect(ports.sent[0]!.text).toContain("acme/widgets#4 ci-failed at aaaaaaa, no fixer woken");
    expect(ports.sent[1]!.text).toContain("0 open");
  });

  it("ignores a seat notice recorded before it carried its gate", async () => {
    const ports = fakePorts();

    await sendSeatDigests([{ row: row(4), run: run("run-4", "await-new-head:0", { sent: true, detail: "told widgets-coord" }) }], ports, memoryMap());

    expect(ports.sent).toHaveLength(0);
  });

  it("reports a finished run once, and takes runs finished before the seat's first digest as known", async () => {
    const ports = fakePorts();
    const memory = memoryMap();
    const history = finished(1, { kind: "merged", reason: null });

    await sendSeatDigests([history], ports, memory);
    await sendSeatDigests([history, finished(2, { kind: "stopped", reason: "abandoned" })], ports, memory);
    await sendSeatDigests([history, finished(2, { kind: "stopped", reason: "abandoned" })], ports, memory);

    expect(ports.sent).toHaveLength(1);
    expect(ports.sent[0]!.text).toContain("1 newly finished");
    expect(ports.sent[0]!.text).toContain("acme/widgets#2 stopped (abandoned)");
    expect(ports.sent[0]!.text).not.toContain("#1 merged");
  });

  it("retries a seat whose send failed on the next sweep, without blocking the others", async () => {
    const memory = memoryMap();
    const inputs = [gated(1, "approve-merge"), gated(2, "approve-merge", "acme/gears")];

    const first = await sendSeatDigests(inputs, fakePorts(new Set(["gears-coord"])), memory);
    const retry = fakePorts();
    await sendSeatDigests(inputs, retry, memory);

    expect(first.sent).toEqual(["widgets-coord"]);
    expect(first.failed).toEqual([{ seat: "gears-coord", cause: "broker down" }]);
    expect(retry.sent.map((m) => m.seat)).toEqual(["gears-coord"]);
  });

  it("skips a repo no single seat owns", async () => {
    const ports = fakePorts();

    await sendSeatDigests([gated(1, "approve-merge", "acme/orphan")], ports, memoryMap());

    expect(ports.sent).toHaveLength(0);
  });
});

describe("fileSeatDigestMemory", () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("keeps what each seat was told across a restart, so an unchanged state sends nothing", async () => {
    dir = mkdtempSync(join(tmpdir(), "seat-digest-"));
    const inputs = [gated(1, "approve-merge")];
    const before = fakePorts();
    await sendSeatDigests(inputs, before, fileSeatDigestMemory(dir));

    const after = fakePorts();
    await sendSeatDigests(inputs, after, fileSeatDigestMemory(dir));

    expect(before.sent).toHaveLength(1);
    expect(after.sent).toHaveLength(0);
  });
});
