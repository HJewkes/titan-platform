import { describe, expect, it } from "vitest";
import { gitBehind } from "./deploy-behind.js";
import { deployHealth, withGitBehind } from "./deploy-health.js";

const RUNNING = "a".repeat(40);
const NOW = Date.parse("2026-10-07T12:00:00Z");
const minutesAgo = (minutes: number): number => NOW - minutes * 60_000;
const quiet = deployHealth({ entries: [], runningSha: RUNNING, now: NOW });

const gitLog = (times: number[], code = 0, stderr = "") => async () => ({ code, stdout: times.map((time) => `${time / 1000}\n`).join(""), stderr });

describe("a running sha behind origin/main with no deploy asked", () => {
  it("reports the merges behind and the age of the oldest, and alarms past the threshold", async () => {
    const times = [5, 20, 30, 40, 50, 70, 80, 90, 100, 110].map(minutesAgo);

    const git = await gitBehind("/checkout", gitLog(times))(RUNNING);
    const result = withGitBehind(quiet, git, NOW);

    expect(result).toMatchObject({ behind: 10, behindMinutes: 110, alarm: true });
    expect(result.causes).toEqual(expect.arrayContaining([expect.stringContaining("10 green merges"), expect.stringContaining("110 min ago")]));
  });

  it("stays quiet when a few recent merges are behind", async () => {
    const git = await gitBehind("/checkout", gitLog([minutesAgo(5), minutesAgo(2)]))(RUNNING);

    expect(withGitBehind(quiet, git, NOW)).toMatchObject({ behind: 2, behindMinutes: 5, alarm: false });
  });

  it("reads 0 only when origin/main holds nothing the build lacks", async () => {
    const git = await gitBehind("/checkout", gitLog([]))(RUNNING);

    expect(withGitBehind(quiet, git, NOW)).toMatchObject({ behind: 0, behindMinutes: 0, alarm: false });
  });

  it("keeps the larger of git's count and the log's", () => {
    const logged = { ...quiet, behind: 7, behindMinutes: 80 };

    expect(withGitBehind(logged, { merges: 2, oldestAt: minutesAgo(10) }, NOW)).toMatchObject({ behind: 7, behindMinutes: 80 });
  });
});

describe("fail closed when git cannot be read", () => {
  it("alarms on a git failure instead of reporting behind 0", async () => {
    const git = await gitBehind("/checkout", gitLog([], 128, "fatal: bad revision\nmore"))(RUNNING);
    const result = withGitBehind(quiet, git, NOW);

    expect(git).toEqual({ unknown: expect.stringContaining("exited 128: fatal: bad revision") });
    expect(result.alarm).toBe(true);
    expect(result.unverified).toContain("unknown");
  });

  it("alarms when git is not on PATH", async () => {
    expect(await gitBehind("/checkout", async () => undefined)(RUNNING)).toEqual({ unknown: "git is not on PATH" });
  });

  it("alarms when the running sha is unknown, without asking git", async () => {
    let asked = false;
    const git = await gitBehind("/checkout", async () => ((asked = true), undefined))("unknown");

    expect(asked).toBe(false);
    expect(withGitBehind(quiet, git, NOW).alarm).toBe(true);
  });

  it("compares a dirty build from its base commit", async () => {
    const seen: string[][] = [];
    await gitBehind("/checkout", async (_file, args) => (seen.push([...args]), { code: 0, stdout: "", stderr: "" }))(`${RUNNING}-dirty`);

    expect(seen[0]).toContain(`${RUNNING}..origin/main`);
  });
});
