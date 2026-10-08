import { describe, expect, it } from "vitest";
import { deployBlockOf, deployHealth, deploySummary, parseRedeployLog, type MainLag } from "./deploy-health.js";

const SHA = "a".repeat(40);
const NEXT = "b".repeat(40);
const NOW = Date.parse("2026-10-07T12:00:00Z");
const CURRENT: MainLag = { behind: 0 };

const start = (at: string, sha = NEXT): string => `${at} service deploy --expect ${sha}`;
const lockRefusal = [
  `error: deploy refused: git merge --ff-only ${NEXT} failed: exit 128`,
  "stderr:",
  "fatal: Unable to create '/srv/checkout/.git/index.lock': File exists.",
];

function health(log: string[], lag: MainLag | string = CURRENT, lockNote?: string) {
  return deployHealth({ outcomes: parseRedeployLog(log.join("\n")), runningSha: SHA, lag, now: NOW, ...(lockNote && { lockNote }) });
}

describe("deploy health from redeploy.log", () => {
  it("raises the alarm on two refusals in a row and names the last one", () => {
    const result = health([start("2026-10-07T08:00:00Z"), ...lockRefusal, start("2026-10-07T08:10:00Z"), ...lockRefusal]);

    expect(result.alarm).toBe(true);
    expect(result.consecutiveRefusals).toBe(2);
    expect(result.lastRefusal).toEqual({ at: "2026-10-07T08:10:00Z", reason: lockRefusal.join("\n").replace("error: ", "") });
    expect(result.causes).toEqual([`service deploy refused 2 times in a row; last: deploy refused: git merge --ff-only ${NEXT} failed: exit 128`]);
  });

  it("keeps quiet after one refusal", () => {
    const result = health([start("2026-10-07T08:00:00Z"), ...lockRefusal]);

    expect(result.alarm).toBe(false);
    expect(result.consecutiveRefusals).toBe(1);
  });

  it("clears the alarm once a deploy lands after the refusals, keeping the last refusal for the record", () => {
    const result = health([start("2026-10-07T08:00:00Z"), ...lockRefusal, start("2026-10-07T08:10:00Z"), ...lockRefusal, start("2026-10-07T09:00:00Z"), `deployed ${NEXT}`]);

    expect(result.alarm).toBe(false);
    expect(result.consecutiveRefusals).toBe(0);
    expect(result.lastRefusal?.at).toBe("2026-10-07T08:10:00Z");
  });

  it("counts a skipped or already-deployed run as a success", () => {
    const skipped = health([start("2026-10-07T08:00:00Z"), ...lockRefusal, `skipped ${NEXT}: no changed path reaches the factory build`]);
    const already = health([start("2026-10-07T08:00:00Z"), ...lockRefusal, `already deployed: build ${NEXT} contains ${NEXT}`]);

    expect([skipped.consecutiveRefusals, already.consecutiveRefusals]).toEqual([0, 0]);
  });

  it("counts a held or rolled-back deploy as a refusal, and ignores a deployer that lost the lock to another", () => {
    const result = health([
      start("2026-10-07T08:00:00Z"),
      `error: deploy held: ${NEXT} rolled back at 2026-10-07T07:00:00Z (build failed); a newer main sha deploys`,
      start("2026-10-07T08:05:00Z"),
      "error: another deploy is running (pid 42 holds /state/deploy.lock)",
      start("2026-10-07T08:10:00Z"),
      `error: rolled-back ${NEXT}: the restarted service did not come up healthy`,
    ]);

    expect(result.consecutiveRefusals).toBe(2);
    expect(result.alarm).toBe(true);
  });

  it("appends the index.lock report to a refusal that names index.lock", () => {
    const result = health([start("2026-10-07T08:00:00Z"), ...lockRefusal], CURRENT, "stale /srv/checkout/.git/index.lock, 580 min old");

    expect(result.lastRefusal?.reason.split("\n").at(-1)).toBe("stale /srv/checkout/.git/index.lock, 580 min old");
  });

  it("leaves a refusal that does not name index.lock as it was", () => {
    const result = health([start("2026-10-07T08:00:00Z"), "error: deploy refused: pnpm is not on PATH"], CURRENT, "stale lock");

    expect(result.lastRefusal?.reason).toBe("deploy refused: pnpm is not on PATH");
  });
});

describe("deploy health from the lag behind origin/main", () => {
  it("raises the alarm when the build is more than 3 merges behind", () => {
    const result = health([], { behind: 4, oldestAt: NOW - 5 * 60_000 });

    expect(result).toMatchObject({ alarm: true, behind: 4, behindMinutes: 5 });
    expect(result.causes).toEqual([`serve runs ${SHA}, 4 merges behind origin/main`]);
  });

  it("raises the alarm when the oldest missing merge landed more than 60 minutes ago", () => {
    const result = health([], { behind: 1, oldestAt: NOW - 61 * 60_000 });

    expect(result).toMatchObject({ alarm: true, behind: 1, behindMinutes: 61 });
    expect(result.causes).toEqual(["serve has been behind origin/main for 61 min"]);
  });

  it("keeps quiet at exactly 3 merges and 60 minutes", () => {
    expect(health([], { behind: 3, oldestAt: NOW - 60 * 60_000 }).alarm).toBe(false);
  });

  it("reports an unreadable lag without raising the alarm on it", () => {
    const result = health([], "gh compare failed (1): HTTP 502");

    expect(result).toMatchObject({ alarm: false, behind: null, behindMinutes: null, lagUnknown: "gh compare failed (1): HTTP 502" });
  });
});

describe("the deploy block as status shows it", () => {
  it("summarizes an alarm on one line", () => {
    const line = deploySummary(health([], { behind: 4 }));

    expect(line).toBe(`deploy: running ${SHA}, 4 behind origin/main, 0 refusal(s) in a row; ALARM: serve runs ${SHA}, 4 merges behind origin/main\n`);
  });

  it("reads the block back from a /health answer and rejects anything else", () => {
    const block = health([], CURRENT);

    expect(deployBlockOf({ deploy: JSON.parse(JSON.stringify(block)) })).toEqual(block);
    expect(deployBlockOf({ deploy: { alarm: "yes" } })).toBeNull();
    expect(deployBlockOf(null)).toBeNull();
  });
});
