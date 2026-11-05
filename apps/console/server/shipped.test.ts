import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dayWindow } from "./coord-day.js";
import { mergedInWindow, mergeTimes, prSetHash, readShipped, writeDigest, type ShippedDigest } from "./shipped.js";
import type { ShepherdSource } from "./shepherd.js";

type WatchRow = Awaited<ReturnType<ShepherdSource["list"]>>[number];

const WINDOW = dayWindow(Date.parse("2031-03-05T12:00:00"), "07:00", "2031-03-05");
const at = (time: string): string => new Date(`2031-03-0${time}`).toISOString();

function finished(pr: number, kind: string, since: string, task = "example/EX-1"): WatchRow {
  return {
    repo: "example-org/repo", pr, branch: `feat/${pr}`, runId: `run-${pr}`, task, phase: "done", headSha: "a1b2c3d", phaseSince: at(since),
    nextAction: "none", pendingGate: null, held: null, stalled: null, outcome: { kind },
  };
}

/** A Shepherd that answers the finished list and, per run, a timeline whose `sh-landed` step completed at `landed[pr]`; a PR without one has no such step. */
function fakeShepherd(rows: WatchRow[], landed: Record<number, string> = {}): { source: Pick<ShepherdSource, "list" | "timeline">; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    source: {
      list: async (state) => (calls.push(`list:${state}`), rows),
      timeline: async (_repo, pr) => {
        calls.push(`timeline:${pr}`);
        const entries = landed[pr] === undefined ? [] : [{ kind: "step", stepId: "sh-landed", completedAt: landed[pr] }];
        return { row: rows.find((row) => row.pr === pr)!, entries };
      },
    },
  };
}

const digestFor = (merged: ReturnType<typeof mergedInWindow>): ShippedDigest => ({
  v: 1, date: "2031-03-05", builtAt: "2031-03-05T07:10:00.000Z", prSetHash: prSetHash(merged),
  groups: [{ initiative: "example", themes: [{ title: "Theme", summary: "Did a thing", prs: merged }], unsummarized: [] }],
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-shipped-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("mergedInWindow", () => {
  it("keeps the run merged inside the window, not one merged before it or one stopped inside it", () => {
    const rows = [finished(1, "merged", "5T10:00:00"), finished(2, "merged", "5T06:59:00"), finished(3, "stopped", "5T11:00:00")];

    const merged = mergedInWindow(rows, WINDOW);

    expect(merged.map((pr) => pr.number)).toEqual([1]);
  });

  it("ends the window at the next day start, exclusive", () => {
    const rows = [finished(1, "merged", "6T06:59:00"), finished(2, "merged", "6T07:00:00")];

    expect(mergedInWindow(rows, WINDOW).map((pr) => pr.number)).toEqual([1]);
  });

  it("splits the task into initiative and id and links the pull request", () => {
    const [pr] = mergedInWindow([finished(7, "merged", "5T10:00:00", "example/EX-9")], WINDOW);

    expect(pr).toEqual({ repo: "example-org/repo", number: 7, task: "EX-9", initiative: "example", url: "https://github.com/example-org/repo/pull/7" });
  });
});

describe("merge time", () => {
  it("lands a PR merged 06:40 on its own day even though the run's phase flipped at 07:20", async () => {
    const rows = [finished(1, "merged", "5T07:20:00")];
    const times = await mergeTimes(fakeShepherd(rows, { 1: at("5T06:40:00") }).source, rows, dayWindow(Date.parse("2031-03-05T12:00:00"), "07:00", "2031-03-04"));

    expect(mergedInWindow(rows, dayWindow(Date.parse("2031-03-05T12:00:00"), "07:00", "2031-03-04"), times).map((pr) => pr.number)).toEqual([1]);
    expect(mergedInWindow(rows, WINDOW, times)).toEqual([]);
  });

  it("falls back to phaseSince when the timeline has no landed step", async () => {
    const rows = [finished(1, "merged", "5T10:00:00")];

    const times = await mergeTimes(fakeShepherd(rows).source, rows, WINDOW);

    expect(mergedInWindow(rows, WINDOW, times).map((pr) => pr.number)).toEqual([1]);
  });

  it("falls back to phaseSince when the timeline cannot be read", async () => {
    const rows = [finished(1, "merged", "5T10:00:00")];
    const broken = { timeline: async () => Promise.reject(new Error("down")) };

    expect((await mergeTimes(broken, rows, WINDOW)).size).toBe(0);
  });

  it("reads a run's timeline once per source, however often the page loads", async () => {
    const rows = [finished(1, "merged", "5T10:00:00")];
    const shepherd = fakeShepherd(rows, { 1: at("5T09:20:00") });

    await mergeTimes(shepherd.source, rows, WINDOW);
    const again = await mergeTimes(shepherd.source, rows, WINDOW);

    expect(shepherd.calls).toEqual(["timeline:1"]);
    expect(again.get("run-1")).toBe(Date.parse(at("5T09:20:00")));
  });

  it("reads no timeline for a stopped run or one that phased long after the window", async () => {
    const rows = [finished(1, "stopped", "5T10:00:00"), finished(2, "merged", "9T10:00:00")];
    const shepherd = fakeShepherd(rows);

    await mergeTimes(shepherd.source, rows, WINDOW);

    expect(shepherd.calls).toEqual([]);
  });
});

describe("coord.shipped read", () => {
  const now = Date.parse("2031-03-05T20:00:00");

  it("reports built:false with the merged list when no digest exists, and reads only Shepherd's own list and timeline", async () => {
    const shepherd = fakeShepherd([finished(1, "merged", "5T10:00:00")]);

    const result = await readShipped(shepherd.source, { dir }, now, "2031-03-05");

    expect(result).toMatchObject({ date: "2031-03-05", built: false, stale: false, digest: null });
    expect(result.merged).toHaveLength(1);
    expect(shepherd.calls).toEqual(["list:finished", "timeline:1"]);
  });

  it("returns the cached digest as fresh when the merged set hashes the same", async () => {
    const rows = [finished(1, "merged", "5T10:00:00")];
    await writeDigest(dir, digestFor(mergedInWindow(rows, WINDOW)));

    const result = await readShipped(fakeShepherd(rows).source, { dir }, now, "2031-03-05");

    expect(result).toMatchObject({ built: true, stale: false });
    expect(result.digest?.groups[0]?.themes[0]?.title).toBe("Theme");
  });

  it("marks the digest stale when a PR merged after it was built", async () => {
    await writeDigest(dir, digestFor(mergedInWindow([finished(1, "merged", "5T10:00:00")], WINDOW)));
    const rows = [finished(1, "merged", "5T10:00:00"), finished(2, "merged", "5T18:00:00")];

    const result = await readShipped(fakeShepherd(rows).source, { dir }, now, "2031-03-05");

    expect(result).toMatchObject({ built: true, stale: true });
    expect(result.merged).toHaveLength(2);
  });

  it("treats a file that is not a v1 digest as unbuilt", async () => {
    await writeDigest(dir, digestFor([]));
    await writeFile(path.join(dir, "2031-03-05.json"), "{\"v\":2}");

    const result = await readShipped(fakeShepherd([]).source, { dir }, now, "2031-03-05");

    expect(result.built).toBe(false);
  });

  it("without a date reads the window that holds now, so 03:00 is still yesterday", async () => {
    const early = Date.parse("2031-03-06T03:00:00");

    const result = await readShipped(fakeShepherd([]).source, { dir }, early);

    expect(result.date).toBe("2031-03-05");
  });
});

describe("writeDigest", () => {
  it("writes the file owner-only and leaves no temp file behind", async () => {
    await writeDigest(dir, digestFor([]));

    expect((await stat(path.join(dir, "2031-03-05.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["2031-03-05.json"]);
  });
});
