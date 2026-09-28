// The committed fixtures are real indexes; the counts here are the ones they were exported with, so silent rot fails.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSnapshot, staticSource, type Snapshot } from "@titan-design/rpc-client";
import { EXIT, type JsonEnvelope } from "@titan-design/rpc-protocol";
import { CALLS, NO_FILTERS } from "../src/data/calls.js";

/** Printed by `pnpm --filter code-report fixtures`; these move only when the fixtures are rebuilt. */
const PLATFORM = { snapshots: 17, newest: 17, calls: 64, gaps: 10, firstLoc: 14551, lastLoc: 60490 };
const DESIGN = {
  snapshot: 1, calls: 87, findings: 60, pageRows: 25, ruleFacets: { "max-cyclomatic-per-function": 3, "max-file-loc": 57 },
  commit: "028e30b1495ba5f61cf1500415fa5a02a62640bb", dirtyFiles: 4,
};

interface Provenance {
  repo: string;
  commit: string;
  dirty: boolean;
  dirtyFiles: number;
}

function load(name: string): Snapshot & { provenance: Provenance } {
  return parseSnapshot(JSON.parse(readFileSync(path.join(import.meta.dirname, "../fixtures", name), "utf8"))) as Snapshot & { provenance: Provenance };
}

function answer(snapshot: Snapshot, command: string, args: unknown): Promise<JsonEnvelope<unknown>> {
  return staticSource({ snapshot }).call(command, args);
}

async function data<T>(snapshot: Snapshot, command: string, args: unknown): Promise<T> {
  const envelope = await answer(snapshot, command, args);
  if (!envelope.ok) throw new Error(`${command} ${JSON.stringify(args)}: ${envelope.error}`);
  return envelope.data as T;
}

interface NodeData {
  metrics: Array<{ name: string; value: number | null }>;
}

interface SnapshotList {
  snapshots: Array<{ id: number; indexVersion: string; takenAt: string; commit: string }>;
}

/** takenAt is the commit's date, not the indexing clock, and the newest one is the file's createdAt. */
async function expectPinnedDates(snapshot: Snapshot): Promise<void> {
  const { snapshots } = await data<SnapshotList>(snapshot, "snapshot.list", { limit: 500 });
  const times = snapshots.map((s) => Date.parse(s.takenAt));
  expect(times).toEqual([...times].sort((a, b) => b - a));
  expect(times[0]).toBe(Date.parse(snapshot.createdAt));
}

/** The series a line chart draws: one node's metric at each snapshot, oldest first, null where the node is absent. */
async function timeline(snapshot: Snapshot, nodeId: string, metric: string): Promise<Array<number | null>> {
  const { snapshots } = await data<SnapshotList>(snapshot, "snapshot.list", { limit: 500 });
  const points: Array<number | null> = [];
  for (const info of [...snapshots].reverse()) {
    const envelope = await answer(snapshot, "node.get", CALLS.node(info.id, nodeId));
    points.push(envelope.ok ? ((envelope.data as NodeData).metrics.find((m) => m.name === metric)?.value ?? null) : null);
  }
  return points;
}

/** Every recorded call answers; a `node.get` for a node the snapshot predates answers NOINPUT, which is a gap. */
async function replay(snapshot: Snapshot): Promise<{ calls: number; gaps: number }> {
  const source = staticSource({ snapshot });
  let gaps = 0;
  for (const key of Object.keys(snapshot.calls)) {
    const [command, args] = JSON.parse(key) as [string, unknown];
    const envelope = await source.call(command, args);
    if (envelope.ok) continue;
    expect(`${command} ${envelope.code}`).toBe(`node.get ${EXIT.NOINPUT}`);
    gaps += 1;
  }
  return { calls: Object.keys(snapshot.calls).length, gaps };
}

describe("titan-platform history fixture", () => {
  const snapshot = load("titan-platform-history.snapshot.json");

  it("holds one snapshot per indexed tag, all from the same indexer", async () => {
    const { snapshots } = await data<SnapshotList>(snapshot, "snapshot.list", { limit: 500 });
    expect(snapshots).toHaveLength(PLATFORM.snapshots);
    expect([...new Set(snapshots.map((s) => s.indexVersion))]).toEqual(["0.15.0"]);
  });

  it("draws the repository's lines of code growing across the whole span", async () => {
    const points = await timeline(snapshot, "", "loc");
    expect(points).toHaveLength(PLATFORM.snapshots);
    expect(points[0]).toBe(PLATFORM.firstLoc);
    expect(points.at(-1)).toBe(PLATFORM.lastLoc);
  });

  it("draws a leading gap for a package added part way through the history", async () => {
    const points = await timeline(snapshot, "packages/messaging/", "loc");
    expect(points.filter((p) => p === null)).toHaveLength(PLATFORM.gaps);
    expect(points.slice(PLATFORM.gaps).every((p) => typeof p === "number")).toBe(true);
  });

  it("has no findings, because the rules it was built with are the ones CI keeps at zero", async () => {
    const counts = await data<{ total: number }>(snapshot, "findings.list", CALLS.findingCounts(PLATFORM.newest));
    expect(counts.total).toBe(0);
  });

  it("answers every call it recorded", async () => {
    expect(await replay(snapshot)).toEqual({ calls: PLATFORM.calls, gaps: PLATFORM.gaps });
  });

  it("dates each snapshot by its tag's commit and records where it came from", async () => {
    await expectPinnedDates(snapshot);
    expect(snapshot.provenance.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("titan-design fixture", () => {
  const snapshot = load("titan-design.snapshot.json");

  it("holds the findings its facets were counted from", async () => {
    const counts = await data<{ total: number; facets: Record<string, Record<string, number>> }>(
      snapshot,
      "findings.list",
      CALLS.findingCounts(DESIGN.snapshot),
    );
    expect(counts.total).toBe(DESIGN.findings);
    expect(counts.facets.rule).toEqual(DESIGN.ruleFacets);
  });

  it("pages that list twenty-five rows at a time", async () => {
    const page = await data<{ rows: unknown[]; total: number }>(snapshot, "findings.list", CALLS.findingsPage(DESIGN.snapshot, NO_FILTERS, "severity", 0));
    expect(page.rows).toHaveLength(DESIGN.pageRows);
    expect(page.total).toBe(DESIGN.findings);
  });

  it("answers every call it recorded", async () => {
    expect(await replay(snapshot)).toEqual({ calls: DESIGN.calls, gaps: 0 });
  });

  it("dates its snapshot by the commit and says the source checkout was dirty", async () => {
    await expectPinnedDates(snapshot);
    expect(snapshot.provenance).toMatchObject({ commit: DESIGN.commit, dirty: true, dirtyFiles: DESIGN.dirtyFiles });
  });
});
