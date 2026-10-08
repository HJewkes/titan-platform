import { describe, expect, it } from "vitest";
import { deployBlockOf, deployHealth, deploySummary, parseRedeployLog } from "./deploy-health.js";

const SHA = "a".repeat(40);
const NEXT = "b".repeat(40);
const LATER = "c".repeat(40);
const NOW = Date.parse("2026-10-07T12:00:00Z");

const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString().replace(".000Z", "Z");
const ask = (minutes: number, sha = NEXT): string => `${minutesAgo(minutes)} service deploy --expect ${sha}`;
const lockRefusal = [
  `error: deploy refused: git merge --ff-only ${NEXT} failed: exit 128`,
  "stderr:",
  "fatal: Unable to create '/srv/checkout/.git/index.lock': File exists.",
];
const pastRefusal = (head: string, target: string): string =>
  `error: deploy refused: the checkout's main is at ${head}, already past ${target}; deploy that commit instead with titan-factory service deploy --expect ${head}`;

function health(log: string[], lockNote?: string, runningSha = SHA) {
  return deployHealth({ entries: parseRedeployLog(log.join("\n")), runningSha, now: NOW, ...(lockNote && { lockNote }) });
}

describe("deploy health from refusals in redeploy.log", () => {
  it("raises the alarm on two refusals in a row and names the last one", () => {
    const result = health([ask(10), ...lockRefusal, ask(5), ...lockRefusal]);

    expect(result.alarm).toBe(true);
    expect(result.consecutiveRefusals).toBe(2);
    expect(result.lastRefusal).toEqual({ at: minutesAgo(5), reason: lockRefusal.join("\n").replace("error: ", "") });
    expect(result.causes).toEqual([`service deploy refused 2 times in a row; last: deploy refused: git merge --ff-only ${NEXT} failed: exit 128`]);
  });

  it("keeps quiet after one refusal", () => {
    const result = health([ask(5), ...lockRefusal]);

    expect(result).toMatchObject({ alarm: false, consecutiveRefusals: 1 });
  });

  it("clears the alarm once a deploy lands after the refusals, keeping the last refusal for the record", () => {
    const result = health([ask(30), ...lockRefusal, ask(25), ...lockRefusal, ask(10), `deployed ${NEXT}`]);

    expect(result).toMatchObject({ alarm: false, consecutiveRefusals: 0, behind: 0, behindMinutes: 0 });
    expect(result.lastRefusal?.at).toBe(minutesAgo(25));
  });

  it("counts a skipped or already-deployed run as a landing", () => {
    const skipped = health([ask(10), ...lockRefusal, `skipped ${NEXT}: no changed path reaches the factory build`]);
    const already = health([ask(10), ...lockRefusal, `already deployed: build ${NEXT} contains ${NEXT}`]);

    expect([skipped.consecutiveRefusals, already.consecutiveRefusals]).toEqual([0, 0]);
  });

  it("counts a held or rolled-back deploy as a refusal, and ignores a deployer that lost the lock to another", () => {
    const result = health([
      ask(15),
      `error: deploy held: ${NEXT} rolled back at 2026-10-07T07:00:00Z (build failed); a newer main sha deploys`,
      ask(10),
      "error: another deploy is running (pid 42 holds /state/deploy.lock)",
      ask(5),
      `error: rolled-back ${NEXT}: the restarted service did not come up healthy`,
    ]);

    expect(result).toMatchObject({ alarm: true, consecutiveRefusals: 2 });
  });

  it("counts no refusal when deploys finish out of order and the older target finds the checkout already past it", () => {
    const result = health([ask(12, NEXT), ask(11, LATER), `skipped ${LATER}: no changed path reaches the factory build`, pastRefusal(LATER, NEXT), pastRefusal(LATER, NEXT)]);

    expect(result).toMatchObject({ alarm: false, consecutiveRefusals: 0, lastRefusal: null, behind: 0 });
  });

  it("still counts a past-target refusal whose checkout holds commits off origin/main", () => {
    const offMain = `error: deploy refused: the checkout's main is at ${LATER}, already past ${NEXT} with commits that are not on origin/main; push or remove them from the checkout's main, then rerun`;

    expect(health([ask(10), offMain, ask(5), offMain]).consecutiveRefusals).toBe(2);
  });

  it("appends the index.lock report to a refusal that names index.lock", () => {
    const result = health([ask(5), ...lockRefusal], "stale /srv/checkout/.git/index.lock, 580 min old");

    expect(result.lastRefusal?.reason.split("\n").at(-1)).toBe("stale /srv/checkout/.git/index.lock, 580 min old");
  });

  it("leaves a refusal that does not name index.lock as it was", () => {
    const result = health([ask(5), "error: deploy refused: pnpm is not on PATH"], "stale lock");

    expect(result.lastRefusal?.reason).toBe("deploy refused: pnpm is not on PATH");
  });
});

describe("deploy health from asks that have not landed", () => {
  const burst = [ask(9, "1".repeat(40)), ask(8.5, "2".repeat(40)), ask(8, "3".repeat(40)), ask(8, "4".repeat(40)), ask(7.5, "5".repeat(40)), ask(7, "6".repeat(40))];

  it("keeps quiet through a burst of green merges still inside the grace period", () => {
    const result = health([...burst, "error: another deploy is running (pid 42 holds /state/deploy.lock)"]);

    expect(result).toMatchObject({ alarm: false, behind: 0, behindMinutes: 9 });
  });

  it("keeps quiet once the newest ask of the burst lands, which covers every ask before it", () => {
    expect(health([...burst, `deployed ${"6".repeat(40)}`])).toMatchObject({ alarm: false, behind: 0, behindMinutes: 0 });
  });

  it("keeps the burst's later asks behind when only the first lands, and alarms once they pass the grace", () => {
    const lostLock = "error: another deploy is running (pid 42 holds /state/deploy.lock)";
    const log = [ask(25, "1".repeat(40)), ask(24, "2".repeat(40)), lostLock, ask(24, "3".repeat(40)), lostLock, ask(23, "4".repeat(40)), lostLock, ask(23, "5".repeat(40)), lostLock, `deployed ${"1".repeat(40)}`];

    expect(health(log)).toMatchObject({ alarm: true, behind: 4, behindMinutes: 24 });
  });

  it("covers an ask by an already-deployed line naming its target, and by the running build's own sha", () => {
    const already = health([ask(30, NEXT), `already deployed: build ${LATER} contains ${NEXT}`]);
    const running = health([ask(90, SHA)]);

    expect([already.behind, already.behindMinutes, running.behind, running.alarm]).toEqual([0, 0, 0, false]);
  });

  it("does not let a landing of an older target cover a newer ask", () => {
    const result = health([ask(70, NEXT), ask(65, LATER), `skipped ${NEXT}: no changed path reaches the factory build`]);

    expect(result).toMatchObject({ alarm: true, behind: 1, behindMinutes: 65 });
  });

  it("raises the alarm when more than 3 asks pass the grace period with nothing landed", () => {
    const result = health([ask(25, "1".repeat(40)), ask(24, "2".repeat(40)), ask(23, "3".repeat(40)), ask(22, "4".repeat(40))]);

    expect(result).toMatchObject({ alarm: true, behind: 4, behindMinutes: 25 });
    expect(result.causes).toEqual([`serve runs ${SHA}, and 4 green merges asked to deploy have not landed`]);
  });

  it("raises the alarm when an ask is over 60 minutes old with nothing landed since, and not at 60", () => {
    const late = health([`deployed ${SHA}`, ask(61)]);

    expect(late).toMatchObject({ alarm: true, behind: 1, behindMinutes: 61 });
    expect(late.causes).toEqual(["a deploy asked for 61 min ago has not landed"]);
    expect(health([ask(60)]).alarm).toBe(false);
  });

  it("raises nothing for merges that never asked for a deploy, however long ago the last one landed", () => {
    const result = health([ask(600), `deployed ${NEXT}`]);

    expect(result).toMatchObject({ alarm: false, behind: 0, behindMinutes: 0, consecutiveRefusals: 0 });
  });
});

describe("deploy health once serve runs a build deployed by hand", () => {
  const refusedPair = [ask(90, NEXT), ...lockRefusal, ask(80, LATER), ...lockRefusal];

  it("clears the refusal streak and every older ask when serve runs the newest refused target", () => {
    const result = health(refusedPair, undefined, LATER);

    expect(result).toMatchObject({ alarm: false, consecutiveRefusals: 0, behind: 0, behindMinutes: 0 });
  });

  it("covers the asks up to the running build's ask, and still counts refusals of asks after it", () => {
    const result = health([...refusedPair, ask(30, "d".repeat(40)), ...lockRefusal, ask(25, "e".repeat(40)), ...lockRefusal], undefined, NEXT);

    expect(result).toMatchObject({ alarm: true, consecutiveRefusals: 3, behind: 3, behindMinutes: 80 });
  });

  it("lands nothing for a running build that no ask named", () => {
    expect(health(refusedPair, undefined, "f".repeat(40))).toMatchObject({ alarm: true, consecutiveRefusals: 2, behind: 2 });
  });
});

describe("the deploy block as status shows it", () => {
  it("summarizes an alarm on one line", () => {
    const line = deploySummary(health([ask(61)]));

    expect(line).toBe(`deploy: running ${SHA}, 1 asked deploy(s) not landed, 0 refusal(s) in a row; ALARM: a deploy asked for 61 min ago has not landed\n`);
  });

  it("reads the block back from a /health answer and rejects anything else", () => {
    const block = health([]);

    expect(deployBlockOf({ deploy: JSON.parse(JSON.stringify(block)) })).toEqual(block);
    expect(deployBlockOf({ deploy: { alarm: "yes" } })).toBeNull();
    expect(deployBlockOf(null)).toBeNull();
  });
});
