import { describe, expect, it } from "vitest";
import { EXIT, runCli } from "./cli.js";
import { SERVICE_LABEL, UNIT_NAME } from "./service.js";
import { CRASH_LOOP_WINDOW_MS, type CheckPorts } from "./service-check.js";
import { deployHealth, parseRedeployLog } from "./deploy-health.js";
import type { IndexLock } from "./stale-lock.js";

const UID = 501;
const PID = 4242;
const NOW = Date.parse("2026-01-01T12:00:00Z");
const BUILD = "a".repeat(40);
const TICK_FILE = "/srv/tester/.agent-chat/burndown-status.json";
const tickFixture = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, loop: "burndown-tick", heartbeatAt: new Date(NOW - 60_000).toISOString(), outcome: "failed", consecutiveFailures: 1, lastErrorClass: "LedgerMalformedError", intervalSeconds: 600, ...over });

interface Machine {
  platform?: NodeJS.Platform;
  /** `systemctl --user show` output on Linux. */
  unit?: string;
  /** launchctl print output; undefined means the job is not loaded. */
  print?: string;
  health?: Record<string, unknown> | null;
  /** Successive /health answers, the last repeating; overrides `health`. */
  healthSequence?: (Record<string, unknown> | null)[];
  dead?: number[];
  startedAgoMs?: number;
  installed?: string;
  /** The status file's text; undefined means the file is absent. */
  tick?: string;
  /** The deploy checkout's index.lock; absent by default. */
  lock?: IndexLock;
}

const LOCK = "/srv/checkout/.git/index.lock";

const printed = (fields: string[]): string => `gui/${UID}/${SERVICE_LABEL} = {\n${fields.map((f) => `\t${f}\n`).join("")}}\n`;
const running = printed(["state = running", `pid = ${PID}`, "runs = 1", "last exit code = (never exited)"]);
const healthy = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ok: true, pid: PID, github: "ok", build: { sha: BUILD, behindMain: 0 }, ...extra });

function fakePorts(init: Machine) {
  const calls: string[] = [];
  let probes = 0;
  const ports: CheckPorts = {
    platform: init.platform ?? "darwin",
    uid: UID,
    home: "/srv/tester",
    launchctl: async (args) => {
      calls.push(args.join(" "));
      return init.print === undefined ? { code: 113, stdout: "", stderr: "Could not find service" } : { code: 0, stdout: init.print, stderr: "" };
    },
    systemctl: async (args) => {
      calls.push(`systemctl ${args.join(" ")}`);
      return init.unit === undefined ? { code: 127, stdout: "", stderr: "systemctl not found" } : { code: 0, stdout: init.unit, stderr: "" };
    },
    claude: async () => undefined,
    isDirectory: () => false,
    which: () => undefined,
    health: async () => (init.healthSequence ? (init.healthSequence[Math.min(probes++, init.healthSequence.length - 1)] ?? null) : (init.health ?? null)),
    mkdir: () => undefined,
    writeFile: () => undefined,
    readFile: () => undefined,
    exists: () => false,
    remove: () => undefined,
    sleep: async () => undefined,
    now: () => NOW,
    isAlive: (pid) => !(init.dead ?? []).includes(pid),
    processStartedAt: async () => new Date(NOW - (init.startedAgoMs ?? 3_600_000)),
    installedBuildSha: () => init.installed ?? BUILD,
    tickStatus: () => ({ file: TICK_FILE, text: init.tick }),
    indexLock: async () => init.lock ?? { state: "absent", path: LOCK },
  };
  return { ports, calls };
}

async function check(init: Machine, ...flags: string[]) {
  const { ports, calls } = fakePorts(init);
  let out = "";
  let err = "";
  const io = { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t), env: {} };
  const code = await runCli(["service", "check", ...flags], io, { workflows: [], routes: [], check: ports });
  return { code, out, err, calls };
}

describe("titan-factory service check", () => {
  it("exits 0 when /health answers from the launchd pid with github ok", async () => {
    const { code, out } = await check({ print: running, health: healthy() });

    expect(code).toBe(EXIT.OK);
    expect(out).toBe(`ok: /health answers from pid ${PID} with github ok\n`);
  });

  it("reports not loaded when launchctl has no job", async () => {
    const { code, out } = await check({ health: healthy() });

    expect(code).not.toBe(EXIT.OK);
    expect(out).toMatch(/^not loaded: .*\n$/);
    expect(out.trim().split("\n")).toHaveLength(1);
  });

  it("reports stale pid when another process answers /health", async () => {
    const { code, out } = await check({ print: running, health: healthy({ pid: 999 }) });

    expect(code).not.toBe(EXIT.OK);
    expect(out).toContain("stale pid: port 7410 is answered by pid 999, not launchd pid 4242");
  });

  it("reports stale pid when the launchd pid is dead", async () => {
    const { out } = await check({ print: running, health: null, dead: [PID] });

    expect(out).toContain(`stale pid: launchd pid ${PID} is dead`);
  });

  it("reports stale pid when the launchd pid does not answer /health", async () => {
    const { out } = await check({ print: running, health: null });

    expect(out).toContain(`stale pid: launchd pid ${PID} does not answer /health`);
  });

  it("exits 0 when one failed probe is followed by an ok probe from the job pid", async () => {
    const { code, out } = await check({ print: running, healthSequence: [null, healthy()] });

    expect(code).toBe(EXIT.OK);
    expect(out).toBe(`ok: /health answers from pid ${PID} with github ok\n`);
  });

  it("reports stale pid naming the probe count when three probes all fail", async () => {
    const { code, out } = await check({ print: running, healthSequence: [null, null, null, healthy()] });

    expect(code).not.toBe(EXIT.OK);
    expect(out).toContain(`stale pid: launchd pid ${PID} does not answer /health on port 7410 (3 probes failed)`);
  });

  it("reports a crash loop when the job exited non-zero several times and holds no process", async () => {
    const print = printed(["state = spawn scheduled", "runs = 9", "last exit code = 1"]);

    const { code, out } = await check({ print, health: null });

    expect(code).not.toBe(EXIT.OK);
    expect(out).toContain("crash loop: ");
    expect(out).toContain("last exit 1, 9 runs");
  });

  it("reports a crash loop when the live process is younger than the window and does not answer /health", async () => {
    const print = printed(["state = running", `pid = ${PID}`, "runs = 5", "last exit code = 78"]);

    const { code, out } = await check({ print, health: null, startedAgoMs: CRASH_LOOP_WINDOW_MS - 1_000 });

    expect(code).not.toBe(EXIT.OK);
    expect(out).toContain("crash loop: ");
  });

  it("reports a crash loop when a young process's /health answers ok but not from the launchd pid's own body", async () => {
    const print = printed(["state = running", `pid = ${PID}`, "runs = 5", "last exit code = 78"]);

    const { code, out } = await check({ print, health: healthy({ pid: undefined }), startedAgoMs: CRASH_LOOP_WINDOW_MS - 1_000 });

    expect(code).not.toBe(EXIT.OK);
    expect(out).toContain("crash loop: ");
  });

  it("reports ok for a young process just restarted when /health answers from the launchd pid", async () => {
    const print = printed(["state = running", `pid = ${PID}`, "runs = 3", "last exit code = 15"]);

    const { code, out } = await check({ print, health: healthy(), startedAgoMs: 10_000 });

    expect(code).toBe(EXIT.OK);
    expect(out).toBe(`ok: /health answers from pid ${PID} with github ok\n`);
  });

  it("reports ok for a just-restarted process whose /health carries an unknown build sha", async () => {
    const print = printed(["state = running", `pid = ${PID}`, "runs = 4", "last exit code = 15"]);

    const { code } = await check({ print, health: healthy({ build: { sha: "unknown" } }), startedAgoMs: 10_000 });

    expect(code).toBe(EXIT.OK);
  });

  it("reports stale pid, not ok, for a just-restarted job whose port is answered by a different pid", async () => {
    const print = printed(["state = running", `pid = ${PID}`, "runs = 3", "last exit code = 15"]);

    const { code, out } = await check({ print, health: healthy({ pid: 999 }), startedAgoMs: 10_000 });

    expect(code).not.toBe(EXIT.OK);
    expect(out).toContain("stale pid: port 7410 is answered by pid 999");
  });

  it("does not call an old failure a crash loop once the process has run past the window", async () => {
    const print = printed(["state = running", `pid = ${PID}`, "runs = 5", "last exit code = 78"]);

    const { code } = await check({ print, health: healthy(), startedAgoMs: CRASH_LOOP_WINDOW_MS + 1_000 });

    expect(code).toBe(EXIT.OK);
  });

  it("reports stale build when the server runs another build than the installed dist", async () => {
    const { code, out } = await check({ print: running, health: healthy(), installed: "b".repeat(40) });

    expect(code).not.toBe(EXIT.OK);
    expect(out).toContain(`stale build: the server runs build ${BUILD} but the installed dist is build ${"b".repeat(40)}`);
  });

  it("does not call an unknown build stale", async () => {
    const { code } = await check({ print: running, health: healthy(), installed: "unknown" });

    expect(code).toBe(EXIT.OK);
  });

  it("reports GitHub down when the right pid answers with a failed github check", async () => {
    const { code, out } = await check({ print: running, health: healthy({ github: "gh api rate_limit failed (1): offline" }) });

    expect(code).not.toBe(EXIT.OK);
    expect(out).toContain("GitHub down: /health answers from pid 4242 but its GitHub check is not ok: gh api rate_limit failed (1): offline");
  });

  it("prints the first cause in order when several hold", async () => {
    const { out } = await check({ print: running, health: healthy({ pid: 999, github: "down" }), installed: "b".repeat(40) });

    expect(out).toContain("stale pid: ");
  });

  it("prints cause, pid, health and details as JSON", async () => {
    const { code, out } = await check({ print: running, health: healthy({ github: "down" }) }, "--json");

    expect(code).not.toBe(EXIT.OK);
    expect(JSON.parse(out)).toMatchObject({ ok: false, cause: "GitHub down", pid: PID, health: { github: "down" }, detail: { github: "down" } });
  });

  it("prints a null cause as JSON when healthy", async () => {
    const { code, out } = await check({ print: running, health: healthy() }, "--json");

    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out)).toMatchObject({ ok: true, cause: null, pid: PID });
  });

  it("only reads launchd", async () => {
    const { calls } = await check({ print: running, health: healthy() });

    expect(calls.every((call) => call.startsWith("print "))).toBe(true);
  });

  it("prints byte-identical launchd lines on macOS", async () => {
    const dead = await check({ print: running, health: null, dead: [PID] });
    const empty = await check({ print: printed(["state = not running", "runs = 1", "last exit code = 0"]), health: null });
    const loop = await check({ print: printed(["state = spawn scheduled", "runs = 9", "last exit code = 1"]), health: null });

    expect(dead.out).toBe(`stale pid: launchd pid ${PID} is dead; stop any other process on the port, then run titan-factory service restart\n`);
    expect(empty.out).toBe("stale pid: launchd holds no process; stop any other process on the port, then run titan-factory service restart\n");
    expect(loop.out).toBe(
      `crash loop: ${SERVICE_LABEL} is crash-looping: last exit 1, 9 runs; read serve.err.log in the service log directory, fix it, then run titan-factory service restart\n`,
    );
  });

  describe("on Linux", () => {
    const unit = (fields: Record<string, string | number>): string =>
      Object.entries({ LoadState: "loaded", ActiveState: "active", MainPID: PID, NRestarts: 0, ExecMainStatus: 0, ...fields })
        .map(([key, value]) => `${key}=${value}\n`)
        .join("");
    const linux = (init: Machine, ...flags: string[]) => check({ platform: "linux", ...init }, ...flags);

    it("exits 0 when /health answers from the unit's MainPID with github ok", async () => {
      const { code, out, calls } = await linux({ unit: unit({}), health: healthy() });

      expect(code).toBe(EXIT.OK);
      expect(out).toBe(`ok: /health answers from pid ${PID} with github ok\n`);
      expect(calls).toEqual([`systemctl --user show ${UNIT_NAME} --property=LoadState,ActiveState,MainPID,NRestarts,ExecMainStatus`]);
    });

    it("reports a crash loop when the unit keeps restarting after non-zero exits and holds no process", async () => {
      const { code, out } = await linux({ unit: unit({ ActiveState: "activating", MainPID: 0, NRestarts: 7, ExecMainStatus: 1 }), health: null });

      expect(code).toBe(EXIT.FAILURE);
      expect(out).toBe(
        `crash loop: ${UNIT_NAME} is crash-looping: last exit 1, 7 restarts; read serve.err.log in the service log directory, fix it, then run titan-factory service restart\n`,
      );
    });

    it("reports a crash loop when a young MainPID does not answer /health", async () => {
      const { code, out } = await linux({ unit: unit({ NRestarts: 4, ExecMainStatus: 15 }), health: null, startedAgoMs: 10_000 });

      expect(code).toBe(EXIT.FAILURE);
      expect(out).toMatch(/^crash loop: /);
    });

    it.each(["failed", "inactive"])("reports a dead unit whose ActiveState is %s as holding no process", async (state) => {
      const { code, out } = await linux({ unit: unit({ ActiveState: state, MainPID: 0, NRestarts: 0, ExecMainStatus: 1 }), health: null });

      expect(code).toBe(EXIT.FAILURE);
      expect(out).toBe("stale pid: systemd holds no process; stop any other process on the port, then run titan-factory service restart\n");
    });

    it("reports not loaded when systemd has no unit file", async () => {
      const { code, out } = await linux({ unit: unit({ LoadState: "not-found", ActiveState: "inactive", MainPID: 0 }), health: healthy() });

      expect(code).toBe(EXIT.FAILURE);
      expect(out).toBe(`not loaded: ${UNIT_NAME} is not loaded; run titan-factory service install\n`);
    });

    it("names systemd, never launchd, for a dead or foreign pid", async () => {
      const dead = await linux({ unit: unit({}), health: null, dead: [PID] });
      const foreign = await linux({ unit: unit({}), health: healthy({ pid: 999 }) });

      expect(dead.out).toContain(`stale pid: systemd pid ${PID} is dead`);
      expect(foreign.out).toContain(`not systemd pid ${PID}`);
      expect(dead.out + foreign.out).not.toContain("launchd");
    });
  });

  describe("burndown tick status", () => {
    it("exits 1 naming tick failing and the file path after one failed tick", async () => {
      const { code, out } = await check({ print: running, health: healthy(), tick: tickFixture() });

      expect(code).toBe(EXIT.FAILURE);
      expect(out).toMatch(/^tick failing: /);
      expect(out).toContain(TICK_FILE);
    });

    it("carries the count and class in --json", async () => {
      const { out } = await check({ print: running, health: healthy(), tick: tickFixture({ consecutiveFailures: 2 }) }, "--json");

      expect(JSON.parse(out)).toMatchObject({ cause: "tick failing", detail: { tickFile: TICK_FILE, tickFailures: 2, tickErrorClass: "LedgerMalformedError" } });
    });

    it("exits 0 when the status file is absent", async () => {
      const { code } = await check({ print: running, health: healthy() });

      expect(code).toBe(EXIT.OK);
    });

    it("exits 0 for a fresh ok heartbeat", async () => {
      const { code } = await check({ print: running, health: healthy(), tick: tickFixture({ outcome: "ok", consecutiveFailures: 0 }) });

      expect(code).toBe(EXIT.OK);
    });

    it("reports tick stale when the heartbeat is older than three intervals", async () => {
      const old = new Date(NOW - 1801_000).toISOString();
      const { code, out } = await check({ print: running, health: healthy(), tick: tickFixture({ outcome: "ok", consecutiveFailures: 0, heartbeatAt: old }) });

      expect(code).toBe(EXIT.FAILURE);
      expect(out).toMatch(/^tick stale: /);
    });

    it("judges staleness by the file's own intervalSeconds", async () => {
      const beat = new Date(NOW - 1801_000).toISOString();
      const { code } = await check({ print: running, health: healthy(), tick: tickFixture({ outcome: "ok", consecutiveFailures: 0, heartbeatAt: beat, intervalSeconds: 3600 }) });

      expect(code).toBe(EXIT.OK);
    });

    it("never prints a class holding credential-shaped text", async () => {
      const secret = "ghp_x y0123456789";
      const { out } = await check({ print: running, health: healthy(), tick: tickFixture({ lastErrorClass: secret }) }, "--json");
      const human = (await check({ print: running, health: healthy(), tick: tickFixture({ lastErrorClass: secret }) })).out;

      expect(out + human).not.toContain("ghp_");
      expect(out).toContain("tick failing");
    });

    it("reports stale pid before a failing tick", async () => {
      const { out } = await check({ print: running, health: healthy(), dead: [PID], tick: tickFixture() });

      expect(out).toMatch(/^stale pid: /);
    });
  });

  describe("the deploy alarm and the deploy checkout's index.lock", () => {
    const TARGET = "b".repeat(40);
    const refusal = (at: string): string =>
      `${at} service deploy --expect ${TARGET}\nerror: deploy refused: git merge --ff-only ${TARGET} failed: Unable to create '${LOCK}': File exists.\n`;
    const deployBlock = (log: string): Record<string, unknown> => ({ ...deployHealth({ entries: parseRedeployLog(log), runningSha: BUILD, now: NOW }) });
    const TWO_REFUSALS = refusal("2026-01-01T11:50:00Z") + refusal("2026-01-01T11:55:00Z");
    const STALE: IndexLock = { state: "stale", path: LOCK, ageMs: 42 * 60_000 };

    it("exits 1 naming deploy stalled and the last refusal after two refusals in a row", async () => {
      const { code, out } = await check({ print: running, health: healthy({ deploy: deployBlock(TWO_REFUSALS) }) });

      expect(code).toBe(EXIT.FAILURE);
      expect(out).toMatch(/^deploy stalled: service deploy refused 2 times in a row; last: deploy refused: git merge --ff-only b+ failed: Unable to create/);
      expect(out.split("\n").filter(Boolean)).toHaveLength(1);
    });

    it("exits 0 once a deploy lands after the refusals", async () => {
      const landed = `${TWO_REFUSALS}2026-01-01T11:58:00Z service deploy --expect ${TARGET}\ndeployed ${TARGET}\n`;

      const { code } = await check({ print: running, health: healthy({ deploy: deployBlock(landed) }) });

      expect(code).toBe(EXIT.OK);
    });

    it("carries the running sha, behind count and last refusal in --json", async () => {
      const { out } = await check({ print: running, health: healthy({ deploy: deployBlock(TWO_REFUSALS) }) }, "--json");

      expect(JSON.parse(out)).toMatchObject({ ok: false, cause: "deploy stalled", detail: { runningSha: BUILD, behind: 0, consecutiveRefusals: 2, lastRefusal: expect.stringContaining("index.lock") } });
    });

    it("names a stale index.lock by path and age, and never removes it", async () => {
      const { code, out, calls } = await check({ print: running, health: healthy(), lock: STALE });

      expect(code).toBe(EXIT.FAILURE);
      expect(out).toBe(`stale index.lock: stale ${LOCK}, 42 min old with no process holding it; remove it to unblock the deploy\n`);
      expect(calls.every((call) => call.startsWith("print "))).toBe(true);
    });

    it("reports the stale lock before the deploy alarm it causes, and both after a server fault", async () => {
      const both = await check({ print: running, health: healthy({ deploy: deployBlock(TWO_REFUSALS) }), lock: STALE }, "--json");
      const github = await check({ print: running, health: healthy({ github: "down", deploy: deployBlock(TWO_REFUSALS) }), lock: STALE });

      expect(JSON.parse(both.out)).toMatchObject({ cause: "stale index.lock", detail: { lockPath: LOCK, lockAgeMinutes: 42 } });
      expect(github.out).toMatch(/^GitHub down: /);
    });

    it("exits 0 for a lock a git process holds or one 10 minutes old or less", async () => {
      const held = await check({ print: running, health: healthy(), lock: { state: "held", path: LOCK, ageMs: 60 * 60_000, holder: "a running git, pid 7" } });
      const fresh = await check({ print: running, health: healthy(), lock: { state: "fresh", path: LOCK, ageMs: 5 * 60_000 } });

      expect([held.code, fresh.code]).toEqual([EXIT.OK, EXIT.OK]);
    });
  });
});
