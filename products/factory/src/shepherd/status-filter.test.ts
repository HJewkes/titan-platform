import { describe, expect, it } from "vitest";
import { statusRows } from "../cli-options.js";
import { filterRows, parsePhases } from "./status-filter.js";
import type { Phase, WatchRow } from "./view.js";

const row = (runId: string, phase: Phase, branch: string, task: string): WatchRow => ({
  repo: "acme/widgets",
  pr: 1,
  branch,
  runId,
  task,
  phase,
  headSha: null,
  phaseSince: "2026-01-01T00:00:00.000Z",
  nextAction: "waiting",
  pendingGate: null,
  held: null,
  stalled: null,
  outcome: null,
});

const ROWS = [
  row("live-pc", "ci", "agent-chat/pc-one", "acme/TP-1"),
  row("done-pc", "done", "agent-chat/pc-two", "acme/TP-2"),
  row("review-dc", "review", "dc-three", "other/TP-1"),
  row("failed-feat", "failed", "feat/four", "acme/TP-4"),
];
const ids = (rows: WatchRow[]): string[] => rows.map((r) => r.runId);

describe("shepherd status filters", () => {
  it("--active drops done, failed and cancelled rows", () => {
    const kept = filterRows(ROWS, { active: true });

    expect(ids(kept)).toEqual(["live-pc", "review-dc"]);
  });

  it("--phase keeps only the listed phases", () => {
    const kept = filterRows(ROWS, { phase: parsePhases("review,done") });

    expect(ids(kept)).toEqual(["done-pc", "review-dc"]);
  });

  it("--branch-prefix matches with or without the agent-chat/ prefix", () => {
    const bare = filterRows(ROWS, { branchPrefix: "pc-" });
    const qualified = filterRows(ROWS, { branchPrefix: "agent-chat/pc-" });

    expect(ids(bare)).toEqual(["live-pc", "done-pc"]);
    expect(ids(qualified)).toEqual(["live-pc", "done-pc"]);
  });

  it("--task matches a bare id in any initiative, or a qualified slug/ID exactly, ignoring case", () => {
    const bare = filterRows(ROWS, { task: "tp-1" });
    const qualified = filterRows(ROWS, { task: "ACME/TP-1" });

    expect(ids(bare)).toEqual(["live-pc", "review-dc"]);
    expect(ids(qualified)).toEqual(["live-pc"]);
  });

  it("combines filters as an AND", () => {
    const kept = filterRows(ROWS, { active: true, branchPrefix: "pc-" });

    expect(ids(kept)).toEqual(["live-pc"]);
  });

  it("--all keeps every row, terminal ones included", () => {
    const kept = statusRows("shepherd.status", ROWS, { all: true }) as WatchRow[];

    expect(ids(kept)).toEqual(["live-pc", "done-pc", "review-dc", "failed-feat"]);
  });

  it("no flag still keeps every row", () => {
    const kept = statusRows("shepherd.status", ROWS, {}) as WatchRow[];

    expect(ids(kept)).toEqual(["live-pc", "done-pc", "review-dc", "failed-feat"]);
  });

  it("refuses an unknown phase, naming the valid ones", () => {
    expect(() => parsePhases("ci,mergd")).toThrow(/unknown phase "mergd"; expected one or more of awaiting-pr, ci, .*cancelled/);
  });
});
