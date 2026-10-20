import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GateResolver } from "@titan-design/hitl";
import type { WorkflowRun } from "@titan-design/workflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PendingGate } from "../host.js";
import type { RoundFeedback } from "./round-merge.js";
import { readRounds, roundShips, sweepRoundShips, type HeldAt, type StoredRound } from "./round-ship-sweep.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "round-merge");
const manifest: { round: number } = JSON.parse(readFileSync(join(fixtures, "round.json"), "utf8"));
const gates: PendingGate[] = JSON.parse(readFileSync(join(fixtures, "pending-gates.json"), "utf8"));
const runs: WorkflowRun[] = JSON.parse(readFileSync(join(fixtures, "runs.json"), "utf8"));

const H1 = "a1".repeat(20);
const NOW = new Date("2026-10-06T11:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const notHeld: HeldAt = () => undefined;

const ship = (questionId: string) => ({ questionId, pick: "Ship it" });
const allShipped = ["tb-ship", "tb-icon", "tb-extra", "tb-moved", "tb-conflict", "tb-nogate"].map(ship);
const revised = allShipped.map((answer) => (answer.questionId === "tb-ship" ? { questionId: "tb-ship", pick: "Revise" } : answer));

/** Round `n` of the fixture manifest, built `builtAtMs`, answered with `answers` unless they are undefined. */
function stored(n: number, builtAtMs: number, answers: RoundFeedback["answers"] | undefined, submittedAt = "2026-10-06T10:30:00.000Z"): StoredRound {
  const round = Buffer.from(JSON.stringify({ ...manifest, round: n }));
  const manifestSha256 = createHash("sha256").update(round).digest("hex");
  const feedback = answers && Buffer.from(JSON.stringify({ unit: "example-unit", round: n, manifestSha256, submittedAt, answers }));
  return { id: `example-unit-r${n}`, round, feedback, builtAtMs };
}

const shipFor101 = (rounds: StoredRound[], heldAt: HeldAt = notHeld) => roundShips(rounds, gates, runs, NOW, heldAt).find((each) => "pr" in each ? each.pr.endsWith("#101") : each.runId === "run-101");

describe("roundShips", () => {
  const recase = (value: unknown, from: string, to: string) => JSON.parse(JSON.stringify(value).replaceAll(from, to));
  const ship101 = (round: StoredRound, pendingGates: PendingGate[]) =>
    roundShips([round], pendingGates, runs, NOW, notHeld).find((each) => ("pr" in each ? each.pr.endsWith("#101") : each.runId === "run-101"));
  const displayCase = (n: number): StoredRound => {
    const round = Buffer.from(JSON.stringify(recase({ ...manifest, round: n }, "example-org/example-repo", "Example-Org/Example-Repo")));
    const manifestSha256 = createHash("sha256").update(round).digest("hex");
    const feedback = Buffer.from(JSON.stringify({ unit: "example-unit", round: n, manifestSha256, submittedAt: "2026-10-06T10:30:00.000Z", answers: allShipped }));
    return { id: `example-unit-r${n}`, round, feedback, builtAtMs: 0 };
  };

  it("a round naming the repo in display case answers a gate whose prompt is lower case", () => {
    expect(ship101(displayCase(1), gates)).toMatchObject({ kind: "resolve", runId: "run-101", payload: { decision: "merge", headSha: H1 } });
  });

  it("a mixed-case repo in the gate prompt still resolves", () => {
    const mixed: PendingGate[] = recase(gates, "in example-org/example-repo at", "in Example-ORG/example-Repo at");
    expect(ship101(stored(1, 0, allShipped), mixed)).toMatchObject({ kind: "resolve", runId: "run-101" });
    expect(ship101(displayCase(1), mixed)).toMatchObject({ kind: "resolve", runId: "run-101" });
  });

  it("a different repo with the same PR number is not answered", () => {
    const other: PendingGate[] = recase(gates, "in example-org/example-repo at", "in example-org/other-repo at");
    expect(ship101(displayCase(1), other)).toBeUndefined();
  });

  it("a Ship at the gate's exact head answers it as the owner's merge, naming the round and submit", () => {
    expect(shipFor101([stored(1, 0, allShipped)])).toEqual({
      kind: "resolve",
      roundId: "example-unit-r1",
      runId: "run-101",
      stepId: "approve-merge",
      payload: { decision: "merge", headSha: H1 },
      confirmEvent: "round:example-unit-r1@2026-10-06T10:30:00.000Z",
    });
  });

  it("a Ship submitted before the gate opened still answers it, for a day rather than the two-hour click window", () => {
    expect(shipFor101([stored(1, 0, allShipped, "2026-10-06T07:00:00.000Z")])).toMatchObject({ kind: "resolve", runId: "run-101" });
    expect(shipFor101([stored(1, 0, allShipped, new Date(NOW.getTime() - 25 * HOUR).toISOString())])).toMatchObject({ kind: "pending", reason: expect.stringContaining("stale") });
  });

  it("a Ship at an older head leaves the gate at the new head pending", () => {
    const moved = roundShips([stored(1, 0, allShipped)], gates, runs, NOW, notHeld).find((each) => "pr" in each && each.pr.endsWith("#103"));
    expect(moved).toMatchObject({ kind: "pending", reason: expect.stringContaining("moved") });
  });

  it("no Ship, an unanswered round or a Don't-ship pick, never merges", () => {
    expect(shipFor101([])).toBeUndefined();
    expect(shipFor101([stored(1, 0, undefined)])).toMatchObject({ kind: "pending", reason: expect.stringContaining("unanswered") });
    expect(shipFor101([stored(1, 0, revised)])).toMatchObject({ kind: "pending", reason: expect.stringContaining("tb-ship") });
  });

  it("only the round built last for the PR decides: a later re-ask voids an earlier Ship, and a later Ship stands", () => {
    expect(shipFor101([stored(2, 2000, undefined), stored(1, 1000, allShipped)])).toMatchObject({ kind: "pending", roundId: "example-unit-r2" });
    expect(shipFor101([stored(1, 1000, allShipped), stored(2, 2000, revised)])).toMatchObject({ kind: "pending", roundId: "example-unit-r2" });
    expect(shipFor101([stored(1, 1000, revised), stored(2, 2000, allShipped)])).toMatchObject({ kind: "resolve", roundId: "example-unit-r2" });
  });

  it("a held PR is left pending with the hold's reason even with a Ship at its head", () => {
    const heldAt: HeldAt = (repo, pr, headSha) => (pr === 101 && headSha === H1 ? `g10 review of ${repo}#${pr}` : undefined);
    expect(shipFor101([stored(1, 0, allShipped)], heldAt)).toMatchObject({ kind: "pending", reason: expect.stringContaining("held: g10 review") });
  });

  it("a route gate at a shipped head stays pending: the round showed the render, not that decision", () => {
    const conflict = roundShips([stored(1, 0, allShipped)], gates, runs, NOW, notHeld).find((each) => "pr" in each && each.pr.endsWith("#104"));
    expect(conflict).toMatchObject({ kind: "pending", reason: expect.stringContaining("shepherd-route/conflict") });
  });
});

describe("readRounds and sweepRoundShips", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "round-ship-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function writeRound(round: StoredRound, mtime: Date): void {
    const dir = join(root, round.id);
    mkdirSync(dir);
    writeFileSync(join(dir, "round.json"), round.round);
    if (round.feedback) writeFileSync(join(dir, "feedback.json"), round.feedback);
    utimesSync(join(dir, "round.json"), mtime, mtime);
  }

  it("reads each round with its build time, unanswered ones without feedback, and skips a symlinked file", async () => {
    writeRound(stored(1, 0, allShipped), new Date(1_000_000));
    writeRound(stored(2, 0, undefined), new Date(2_000_000));
    mkdirSync(join(root, "linked"));
    symlinkSync(join(root, "example-unit-r1", "round.json"), join(root, "linked", "round.json"));
    const rounds = (await readRounds(root)).sort((a, b) => a.id.localeCompare(b.id));
    expect(rounds.map(({ id, builtAtMs, feedback }) => ({ id, builtAtMs, answered: feedback !== undefined }))).toEqual([
      { id: "example-unit-r1", builtAtMs: 1_000_000, answered: true },
      { id: "example-unit-r2", builtAtMs: 2_000_000, answered: false },
    ]);
  });

  it("answers a gate that opened before the sweep existed once, as owner-remote from titan-console, and a rerun answers nothing new", async () => {
    writeRound(stored(1, 0, allShipped), new Date(1_000_000));
    let pending = gates.filter((gate) => gate.runId === "run-101");
    const signals: Array<{ runId: string; stepId: string; payload: unknown; resolver: GateResolver }> = [];
    const host = {
      pendingGates: () => pending,
      runtime: {
        status: (runId: string) => runs.find((run) => run.id === runId),
        signal: (runId: string, stepId: string, payload: Record<string, unknown>, resolver: GateResolver) => {
          signals.push({ runId, stepId, payload, resolver });
          pending = [];
        },
      },
    };
    await sweepRoundShips(host, notHeld, root, NOW);
    await sweepRoundShips(host, notHeld, root, NOW);
    expect(signals).toEqual([
      {
        runId: "run-101",
        stepId: "approve-merge",
        payload: { decision: "merge", headSha: H1 },
        resolver: { class: "owner-remote", id: "titan-console", channel: "console:round-ship", confirmEvent: "round:example-unit-r1@2026-10-06T10:30:00.000Z" },
      },
    ]);
  });
});
