import { describe, expect, it } from "vitest";
import { deployHealth, withGitBehind, type DeployHealth } from "../deploy-health.js";
import { countMergedSince, deployCutoff } from "./lane-signals.js";

const RUNNING = "a".repeat(40);
const NOW = Date.parse("2026-10-07T12:00:00Z");
const minutesAgo = (minutes: number): number => NOW - minutes * 60_000;
const quiet = deployHealth({ entries: [], runningSha: RUNNING, now: NOW });

const merged = (minutes: number) => ({ outcome: { kind: "merged" }, phaseSince: new Date(minutesAgo(minutes)).toISOString() });

/** What serve reports when origin/main holds a commit the running build lacks, as of `now`. */
const lacking = (...commitMinutes: number[]): DeployHealth => withGitBehind(quiet, { commitTimes: commitMinutes.map(minutesAgo) }, NOW);

describe("lane merges not yet in the running build", () => {
  it("counts a merge made inside the deploy grace window", () => {
    const deploy = lacking(5);

    expect(countMergedSince([merged(5)], deployCutoff(deploy, NOW))).toBe(1);
  });

  it("does not count a merge older than the running build's oldest missing commit", () => {
    const deploy = lacking(5);

    expect(countMergedSince([merged(60)], deployCutoff(deploy, NOW))).toBe(0);
  });

  it("counts a merge past the grace window as before", () => {
    const deploy = lacking(45);

    expect(countMergedSince([merged(45), merged(90)], deployCutoff(deploy, NOW))).toBe(1);
  });

  it("counts nothing when the running build lacks no commit", () => {
    expect(countMergedSince([merged(1)], deployCutoff(lacking(), NOW))).toBe(0);
  });
});
