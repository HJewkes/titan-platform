import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replaceEpisodes, type EpisodeRow } from "./episodes.js";
import { openSessionGraph, type SessionGraph } from "./graph.js";

const episode = (episodeIndex: number, fields: Partial<EpisodeRow> = {}): EpisodeRow => ({
  episodeIndex, heuristicVersion: 1,
  startedAt: `2026-09-01T0${episodeIndex}:00:00Z`, endedAt: `2026-09-01T0${episodeIndex}:30:00Z`,
  startOffset: episodeIndex * 1000, endOffset: episodeIndex * 1000 + 999, openedBy: episodeIndex === 0 ? "brief" : "idle_gap",
  ...fields,
});

let graph: SessionGraph;
beforeEach(() => {
  graph = openSessionGraph(":memory:");
});
afterEach(() => graph.db.close());

const rows = () =>
  graph.db.prepare("SELECT session_id, heuristic, episode_index, opened_by, first_deliverable_signal FROM episode ORDER BY session_id, heuristic, episode_index").all();

describe("replaceEpisodes", () => {
  it("replaceEpisodes replaces only the named heuristic's rows for that session", () => {
    replaceEpisodes(graph, "s1", "worker-v1", [episode(0), episode(1), episode(2)]);
    replaceEpisodes(graph, "s1", "coordinator-v1", [episode(0)]);
    replaceEpisodes(graph, "s2", "worker-v1", [episode(0)]);

    const written = replaceEpisodes(graph, "s1", "worker-v1", [episode(0, { firstDeliverableSignal: "pr_create" })]);

    expect(written).toBe(1);
    expect(rows()).toEqual([
      { session_id: "s1", heuristic: "coordinator-v1", episode_index: 0, opened_by: "brief", first_deliverable_signal: null },
      { session_id: "s1", heuristic: "worker-v1", episode_index: 0, opened_by: "brief", first_deliverable_signal: "pr_create" },
      { session_id: "s2", heuristic: "worker-v1", episode_index: 0, opened_by: "brief", first_deliverable_signal: null },
    ]);
  });

  it("two heuristics coexist for one session", () => {
    replaceEpisodes(graph, "s1", "worker-v1", [episode(0), episode(1)]);
    replaceEpisodes(graph, "s1", "coordinator-v1", [episode(0, { openedBy: "session_start" }), episode(1, { openedBy: "pr_merge" })]);

    expect(rows()).toEqual([
      { session_id: "s1", heuristic: "coordinator-v1", episode_index: 0, opened_by: "session_start", first_deliverable_signal: null },
      { session_id: "s1", heuristic: "coordinator-v1", episode_index: 1, opened_by: "pr_merge", first_deliverable_signal: null },
      { session_id: "s1", heuristic: "worker-v1", episode_index: 0, opened_by: "brief", first_deliverable_signal: null },
      { session_id: "s1", heuristic: "worker-v1", episode_index: 1, opened_by: "idle_gap", first_deliverable_signal: null },
    ]);
  });

  it("an empty row list clears that heuristic's episodes for the session", () => {
    replaceEpisodes(graph, "s1", "worker-v1", [episode(0)]);

    expect(replaceEpisodes(graph, "s1", "worker-v1", [])).toBe(0);
    expect(rows()).toEqual([]);
  });

  it("leaves the previous rows in place when a row is rejected", () => {
    replaceEpisodes(graph, "s1", "worker-v1", [episode(0)]);

    expect(() => replaceEpisodes(graph, "s1", "worker-v1", [episode(1), episode(1)])).toThrow();
    expect(rows()).toEqual([{ session_id: "s1", heuristic: "worker-v1", episode_index: 0, opened_by: "brief", first_deliverable_signal: null }]);
  });
});
