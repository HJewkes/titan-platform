import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchingGitBehind, gitBehind, type GitBehind } from "./deploy-behind.js";
import type { HeldWanted } from "./deploy-health.js";
import { deployWatch, type DeployWatchPorts } from "./deploy-watch.js";
import { gitBehindMain } from "./test-support/git-line.js";

const RUNNING = "a".repeat(40);
const WANTED = "b".repeat(40);
const NOW = Date.parse("2026-10-17T20:15:00Z");
const MINUTE = 60_000;

/** No redeploy.log at all: every merge landed outside Shepherd's land, so nothing ever asked. */
function ports(origin: GitBehind, wanted?: HeldWanted): DeployWatchPorts {
  return {
    readLog: () => undefined,
    runningSha: () => RUNNING,
    indexLock: async () => ({ state: "absent", path: "/srv/checkout/.git/index.lock" }),
    originBehind: async () => origin,
    deployWanted: () => wanted,
    now: () => NOW,
  };
}

const commitsAgo = (...minutes: number[]): GitBehind => ({ commitTimes: minutes.map((ago) => NOW - ago * MINUTE) });

describe("serve's deploy block reads origin/main and the pacer's held target", () => {
  it("raises the alarm for merges that never asked for a deploy", async () => {
    const watch = deployWatch(ports(commitsAgo(240, 200, 180, 150, 120)));

    await watch.tick();

    expect(watch.status()).toMatchObject({ behind: 5, behindMinutes: 240, originLag: { merges: 5, minutes: 240, asked: 0 }, alarm: true });
  });

  it("alarms for a build 31 behind while the pacer holds the wanted target and nothing asked in the log", async () => {
    const lag = Array.from({ length: 31 }, (_, i) => 100 - i * 2);
    const watch = deployWatch(ports(commitsAgo(...lag), { sha: WANTED, firstAt: new Date(NOW - 70 * MINUTE).toISOString() }));

    await watch.tick();

    expect(watch.status()).toMatchObject({ behind: 31, behindMinutes: 100, originLag: { merges: 31, asked: 1 }, alarm: true });
  });

  it("counts a held wanted target as waiting since its firstAt even when git shows no lag", async () => {
    const watch = deployWatch(ports(commitsAgo(), { sha: WANTED, firstAt: new Date(NOW - 70 * MINUTE).toISOString() }));

    await watch.tick();

    expect(watch.status()).toMatchObject({ behind: 1, behindMinutes: 70, alarm: true });
  });

  it("reads behind 0 when the wanted target is the running build", async () => {
    const watch = deployWatch(ports(commitsAgo(), { sha: RUNNING, firstAt: new Date(NOW - 70 * MINUTE).toISOString() }));

    await watch.tick();

    expect(watch.status()).toMatchObject({ behind: 0, behindMinutes: 0, alarm: false });
  });

  it("reads behind 0 when the running build descends from the wanted target", async () => {
    const watch = deployWatch({ ...ports(commitsAgo(), { sha: WANTED, firstAt: new Date(NOW - 70 * MINUTE).toISOString() }), isAncestor: async () => true });

    await watch.tick();

    expect(watch.status()).toMatchObject({ behind: 0, behindMinutes: 0, alarm: false });
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
