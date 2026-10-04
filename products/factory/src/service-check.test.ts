import { describe, expect, it } from "vitest";
import { EXIT, runCli } from "./cli.js";
import { SERVICE_LABEL } from "./service.js";
import { CRASH_LOOP_WINDOW_MS, type CheckPorts } from "./service-check.js";

const UID = 501;
const PID = 4242;
const NOW = Date.parse("2026-01-01T12:00:00Z");
const BUILD = "a".repeat(40);

interface Machine {
  /** launchctl print output; undefined means the job is not loaded. */
  print?: string;
  health?: Record<string, unknown> | null;
  dead?: number[];
  startedAgoMs?: number;
  installed?: string;
}

const printed = (fields: string[]): string => `gui/${UID}/${SERVICE_LABEL} = {\n${fields.map((f) => `\t${f}\n`).join("")}}\n`;
const running = printed(["state = running", `pid = ${PID}`, "runs = 1", "last exit code = (never exited)"]);
const healthy = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ok: true, pid: PID, github: "ok", build: { sha: BUILD, behindMain: 0 }, ...extra });

function fakePorts(init: Machine) {
  const calls: string[] = [];
  const ports: CheckPorts = {
    platform: "darwin",
    uid: UID,
    home: "/srv/tester",
    launchctl: async (args) => {
      calls.push(args.join(" "));
      return init.print === undefined ? { code: 113, stdout: "", stderr: "Could not find service" } : { code: 0, stdout: init.print, stderr: "" };
    },
    claude: async () => undefined,
    isDirectory: () => false,
    which: () => undefined,
    health: async () => init.health ?? null,
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
});
