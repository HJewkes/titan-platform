import { describe, expect, it } from "vitest";
import type { AgentRosterEntry, AgentRosterSnapshot } from "@titan-design/chat-protocol/agents";
import {
  BLOCKED_AGENT_AFTER_MS,
  DerivedRowRefusedError,
  FAILED_RUN_LOOKBACK_MS,
  STALLED_RUN_AFTER_MS,
  blockedAgentRows,
  derivedRow,
  failedRunRows,
  stalledRunRows,
  type DerivedInput,
} from "./inbox-derived.js";
import type { WatchRow } from "./inbox-view.js";

const NOW = Date.parse("2031-03-05T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function watchRow(runId: string, pr: number, overrides: Partial<WatchRow> = {}): WatchRow {
  return {
    repo: "example/repo", pr, branch: `feat/${pr}`, runId, task: "EX-1", phase: "ci", headSha: null, phaseSince: ago(0),
    nextAction: "wait for CI", pendingGate: null, held: null, stalled: null,
    ...overrides,
  };
}

function agent(name: string, overrides: Partial<AgentRosterEntry> = {}): AgentRosterEntry {
  return {
    id: `${name}@1`, idSource: "nameAtRegisteredAt", name, agentId: null, state: "blocked", stateSource: "presence", origin: "unknown", workingOn: null, cwd: null,
    gitBranch: null, seat: null, surface: null, profile: null, taskId: null, spawnedBy: null, claudeSessionId: null, registeredAt: 1, spawnedAt: null, lastEventAt: null,
    idleMs: 0, dnd: false, provisional: false, tags: [], costUsd: null, costSource: null,
    ...overrides,
  };
}

const roster = (agents: AgentRosterEntry[]): AgentRosterSnapshot => ({ agents, brokerUptimeMs: 60_000, reconnecting: false, history: { events: 0, limit: 1000, oldestAt: null }, generatedAt: NOW });

const input = (evidence: DerivedInput["evidence"]): DerivedInput => ({
  id: "derived:test:1",
  kind: "stalled-run",
  summary: "A run is stalled",
  evidence,
  threshold: { name: "a test limit", limitMs: 0 },
  link: "#/shepherd",
});

describe("derivedRow", () => {
  it("refuses a row that names no evidence", () => {
    expect(() => derivedRow(input(undefined), NOW)).toThrow(DerivedRowRefusedError);
  });

  it.each([
    ["what was observed", { source: "shepherd row r", at: ago(0) }],
    ["the source", { observed: "stalled: x", at: ago(0) }],
    ["the time", { observed: "stalled: x", source: "shepherd row r" }],
    ["a readable time", { observed: "stalled: x", source: "shepherd row r", at: "yesterday" }],
  ])("refuses evidence missing %s", (_, evidence) => {
    expect(() => derivedRow(input(evidence), NOW)).toThrow(DerivedRowRefusedError);
  });

  it("keeps the evidence and measures the threshold's age from its time", () => {
    const row = derivedRow(input({ observed: "stalled: x", source: "shepherd row r", at: ago(5 * 60_000) }), NOW);

    expect(row.evidence).toEqual({ observed: "stalled: x", source: "shepherd row r", at: ago(5 * 60_000) });
    expect(row.threshold).toEqual({ name: "a test limit", limitMs: 0, ageMs: 5 * 60_000 });
  });
});

describe("blocked-agent rows", () => {
  it("raises nothing at exactly the threshold and a row one millisecond past it", () => {
    const rows = blockedAgentRows(roster([agent("at-limit", { idleMs: BLOCKED_AGENT_AFTER_MS }), agent("past-limit", { idleMs: BLOCKED_AGENT_AFTER_MS + 1 })]));

    expect(rows.map((row) => row.summary)).toEqual(["past-limit is blocked"]);
  });

  it("gives the row its age, the agent page link and no action", () => {
    const [row] = blockedAgentRows(roster([agent("relay worker", { idleMs: 40 * 60_000 })]));

    expect(row).toEqual({
      id: "derived:blocked-agent:relay worker@1",
      kind: "blocked-agent",
      summary: "relay worker is blocked",
      evidence: { observed: "presence blocked, silent for 40 min", source: "agent-chat presence", at: ago(40 * 60_000) },
      threshold: { name: "blocked longer than 15 min", limitMs: BLOCKED_AGENT_AFTER_MS, ageMs: 40 * 60_000 },
      link: "#/agents/relay%20worker",
    });
  });

  it("ignores working agents and a blocked state read only from history", () => {
    const long = BLOCKED_AGENT_AFTER_MS * 4;

    expect(blockedAgentRows(roster([agent("busy", { state: "working", idleMs: long }), agent("old", { stateSource: "history", idleMs: null })]))).toEqual([]);
  });
});

describe("Shepherd-derived rows", () => {
  it("raises a stall verdict only once its phase is past the stall threshold", () => {
    const reason = { reason: "3 review dispatches in a row started no reviewer" };
    const active = [watchRow("young", 1, { stalled: reason, phaseSince: ago(STALLED_RUN_AFTER_MS) }), watchRow("old", 2, { stalled: reason, phaseSince: ago(STALLED_RUN_AFTER_MS + 1) }), watchRow("fine", 3, { phaseSince: ago(STALLED_RUN_AFTER_MS * 10) })];

    expect(stalledRunRows(active, NOW).map((row) => row.id)).toEqual(["derived:stalled-run:old"]);
  });

  it("raises a failed run inside the lookback unless its PR has a live run again", () => {
    const finished = [
      watchRow("recent", 1, { phase: "failed", phaseSince: ago(60_000) }),
      watchRow("stale", 2, { phase: "failed", phaseSince: ago(FAILED_RUN_LOOKBACK_MS + 1) }),
      watchRow("retried", 3, { phase: "failed", phaseSince: ago(60_000) }),
      watchRow("merged", 4, { phase: "done", phaseSince: ago(60_000) }),
    ];

    const rows = failedRunRows(finished, [watchRow("retry", 3)], NOW);

    expect(rows.map((row) => [row.id, row.evidence.observed])).toEqual([["derived:failed-run:recent", "phase failed: the run recorded no error"]]);
  });
});
