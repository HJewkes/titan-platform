import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionGraph, type SessionGraph } from "./graph.js";
import { ORIGIN_EXPERIMENT_MIGRATION_NAME } from "./origin-experiment-schema.js";
import { resolveOrigins, type ResolvedOrigin } from "./origin.js";

const ARM_TABLE = `
  SELECT o.experiment_arm, COUNT(*) AS sessions,
         SUM(COALESCE(json_extract(o.followup_kinds, '$.fix'), 0)) AS fix_followups
  FROM session_origin o JOIN session s ON s.session_id = o.session_id
  WHERE o.experiment_id = ? GROUP BY o.experiment_arm ORDER BY o.experiment_arm`;

let graph: SessionGraph;

beforeEach(() => {
  graph = openSessionGraph(":memory:");
});
afterEach(() => graph.db.close());

function addSessions(...ids: string[]): void {
  const insert = graph.db.prepare("INSERT INTO session (session_id, cwd) VALUES (?, '/scratch')");
  for (const id of ids) insert.run(id);
}

async function resolve(origins: Record<string, ResolvedOrigin>): Promise<void> {
  await resolveOrigins(graph, () => ({ origins }));
}

const experimentColumns = (sessionId: string) =>
  graph.db.prepare("SELECT experiment_id, experiment_arm, predecessor, followup_kinds FROM session_origin WHERE session_id = ?").get(sessionId);

const spawned = (arm: string, extra: Partial<ResolvedOrigin> = {}): ResolvedOrigin => ({
  originSystem: "agent-chat", taskIds: [], experimentId: "E3", experimentArm: arm, ...extra,
});

describe("origin experiment columns", () => {
  it("are added by a named migration", () => {
    const applied = graph.db.prepare("SELECT name FROM _migration").pluck().all();

    expect(applied).toContain(ORIGIN_EXPERIMENT_MIGRATION_NAME);
  });

  it("stores experiment, predecessor and follow-up counts from an origin resolution", async () => {
    addSessions("worker");

    await resolve({ worker: spawned("fresh", { predecessor: "tc-cc-168-b", followupKinds: { fix: 2, rebase: 1 } }) });

    expect(experimentColumns("worker")).toEqual({
      experiment_id: "E3", experiment_arm: "fresh", predecessor: "tc-cc-168-b", followup_kinds: '{"fix":2,"rebase":1}',
    });
  });

  it("a re-resolution without them keeps no stale values", async () => {
    addSessions("worker");
    await resolve({ worker: spawned("fresh", { predecessor: "old", followupKinds: { fix: 1 } }) });
    graph.db.prepare("UPDATE session SET ended_at = '2999-01-01T00:00:00Z' WHERE session_id = 'worker'").run();

    await resolve({ worker: { originSystem: "agent-chat", taskIds: [] } });

    expect(experimentColumns("worker")).toEqual({ experiment_id: null, experiment_arm: null, predecessor: null, followup_kinds: null });
  });

  it("one query over session_origin gives the arm table for an experiment", async () => {
    addSessions("a1", "a2", "b1", "other");

    await resolve({
      a1: spawned("fresh", { followupKinds: { fix: 1, review: 1 } }),
      a2: spawned("fresh"),
      b1: spawned("warm", { followupKinds: { fix: 3 } }),
      other: { originSystem: "agent-chat", taskIds: [], experimentId: "E2", experimentArm: "fresh", followupKinds: { fix: 9 } },
    });

    expect(graph.db.prepare(ARM_TABLE).all("E3")).toEqual([
      { experiment_arm: "fresh", sessions: 2, fix_followups: 1 },
      { experiment_arm: "warm", sessions: 1, fix_followups: 3 },
    ]);
  });
});
