import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BY_REC_POLICY_SCHEMA, BY_REC_RESOLVER, BY_REC_ROW_SCHEMA, type ByRecRow } from "@titan-design/owner-queue";
import { appendByRecRows, BY_REC_POLICY_FILE } from "./by-rec-log.js";
import { parseGateRows } from "./log-gate-rows.js";
import { readLog } from "./log-view.js";
import type { ShepherdSource } from "./shepherd.js";

const NOW = Date.parse("2031-03-05T12:00:00.000Z");
let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "log-view-"));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function row(id: string, mode: ByRecRow["mode"], resolvedAt: string, facts: ByRecRow["facts"] = {}): ByRecRow {
  return {
    schema: BY_REC_ROW_SCHEMA, subject: { source: facts.pr === undefined ? "deposit" : "gate", id }, recommendation: { answer: "keep", by: "builder" },
    openedAt: "2031-03-04T02:00:00.000Z", resolvedAt, facts, mode, result: mode === "live" ? "resolved" : "would-resolve", resolver: { ...BY_REC_RESOLVER },
  };
}

type Row = Awaited<ReturnType<ShepherdSource["list"]>>[number];

const merged = (pr: number, phaseSince: string): Row => ({
  repo: "orbit/relay", pr, branch: `b-${pr}`, runId: `run-${pr}`, task: `orbit-relay/OR-${pr}`, phase: "done", headSha: null, phaseSince, nextAction: "", pendingGate: null, held: null, stalled: null, outcome: { kind: "merged" },
});

function shepherd(rows: Row[], fail = false): Pick<ShepherdSource, "list" | "timeline"> {
  return {
    list: async () => {
      if (fail) throw new Error("factory down");
      return rows;
    },
    timeline: async (_repo, pr) => ({ row: rows[0]!, entries: pr === 5 ? [{ kind: "decision", rule: "MRG-AU-RV", stepId: "s", head: "h", reviewer: "r", profile: "p" }] : [] }),
  };
}

describe("log.list", () => {
  it("merges the three sources inside the window and keeps the policy file's exclusions", async () => {
    await writeFile(path.join(stateDir, BY_REC_POLICY_FILE), JSON.stringify({ schema: BY_REC_POLICY_SCHEMA, mode: "live", exclude: [{ field: "category", value: "naming" }] }));
    await appendByRecRows(stateDir, [row("dep-new", "live", "2031-03-05T10:00:00.000Z"), row("dep-old", "live", "2031-02-01T10:00:00.000Z")]);
    const gateRows = async () => ({ rows: [row("gate-5", "shadow", "2031-03-05T09:00:00.000Z", { repo: "orbit/relay", pr: 5 })], gaps: [] });

    const view = await readLog(shepherd([merged(5, "2031-03-05T09:30:00.000Z")]), { stateDir, gateRows, dayStart: "00:00", now: () => NOW }, 7);

    const rows = view.days.flatMap((day) => day.rows);
    expect(rows.map((each) => [each.key, each.approval, each.shadow])).toEqual([["deposit:dep-new", "auto-by-rec", false], ["orbit/relay#5", "reviewer", true]]);
    expect(view.header).toMatchObject({ mode: "live", afterHours: 24, added: [{ field: "category", value: "naming" }] });
    expect(view.gaps).toEqual([]);
  });

  it("answers a gap line, not an error, when Shepherd and the CLI are out", async () => {
    const gateRows = async () => ({ rows: [], gaps: ["shepherd by-rec: not found"] });

    const view = await readLog(shepherd([], true), { stateDir, gateRows, now: () => NOW });

    expect(view.gaps).toEqual(["shepherd: factory down", "shepherd by-rec: not found"]);
    expect(view.days).toEqual([]);
  });
});

describe("shepherd by-rec --json", () => {
  it("keeps rows of the schema and counts the rest in a gap", () => {
    const read = parseGateRows(JSON.stringify({ rows: [row("gate-1", "shadow", "2031-03-05T09:00:00.000Z", { repo: "o/r", pr: 1 }), { schema: "other" }] }));

    expect(read.rows.map((each) => each.subject.id)).toEqual(["gate-1"]);
    expect(read.gaps).toEqual(["shepherd by-rec: 1 row(s) did not match titan/auto-by-rec@1"]);
  });
});
