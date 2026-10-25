import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchingGitBehind, gitBehind, type GitBehind } from "./deploy-behind.js";
import { deployWatch, type DeployWatchPorts } from "./deploy-watch.js";
import { gitBehindMain } from "./test-support/git-line.js";

const RUNNING = "a".repeat(40);
const NOW = Date.parse("2026-10-17T20:15:00Z");
const MINUTE = 60_000;

/** No redeploy.log at all: every merge landed outside Shepherd's land, so nothing ever asked. */
function ports(origin: GitBehind, queued = false): DeployWatchPorts {
  return {
    readLog: () => undefined,
    runningSha: () => RUNNING,
    indexLock: async () => ({ state: "absent", path: "/srv/checkout/.git/index.lock" }),
    originBehind: async () => origin,
    deployQueued: () => queued,
    now: () => NOW,
  };
}

const commitsAgo = (...minutes: number[]): GitBehind => ({ commitTimes: minutes.map((ago) => NOW - ago * MINUTE) });

describe("serve's deploy block reads origin/main when no deploy is queued", () => {
  it("raises the alarm for merges that never asked for a deploy", async () => {
    const watch = deployWatch(ports(commitsAgo(240, 200, 180, 150, 120)));

    await watch.tick();

    expect(watch.status()).toMatchObject({ behind: 5, behindMinutes: 240, originLag: { merges: 5, minutes: 240, asked: 0 }, alarm: true });
  });

  it("leaves the lag to the pacer while deploy-wanted.json holds a queued sha", async () => {
    const watch = deployWatch(ports(commitsAgo(240, 200, 180, 150, 120), true));

    await watch.tick();

    expect(watch.status()).toMatchObject({ behind: 0, alarm: false });
    expect(watch.status()?.originLag).toBeUndefined();
  });

  it("alarms when git cannot read main, rather than reading 0", async () => {
    const watch = deployWatch(ports({ unknown: "git log exited 128" }));

    await watch.tick();

    expect(watch.status()).toMatchObject({ alarm: true, unverified: "serve's lag behind origin/main is unknown: git log exited 128" });
  });
});

describe("fetchingGitBehind", () => {
  it("counts merges the deploy checkout has not fetched, which its own origin/main misses", async () => {
    const repo = gitBehindMain();
    try {
      const running = execFileSync("git", ["-C", repo.checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

      const stale = await gitBehind(repo.checkout, undefined, () => undefined)(running);
      const fetched = await fetchingGitBehind(repo.checkout, undefined, () => undefined)(running);

      expect(stale).toEqual({ commitTimes: [] });
      expect(fetched).toMatchObject({ commitTimes: [expect.any(Number), expect.any(Number)] });
      expect(execFileSync("git", ["-C", repo.checkout, "rev-parse", "origin/main"], { encoding: "utf8" }).trim()).toBe(running);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});
