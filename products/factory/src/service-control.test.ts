import { describe, expect, it } from "vitest";
import { EXIT, runCli } from "./cli.js";
import { plistPath, SERVICE_LABEL, serviceLabel } from "./service.js";
import type { BusyRun } from "./restart-drain.js";
import { LEAKY_MESSAGE, expectNoLeak } from "./test-support/leak.js";
import type { CommandResult, ServicePorts } from "./service-control.js";

const HOME = "/srv/tester";
const UID = 501;
const TARGET = `gui/${UID}/${SERVICE_LABEL}`;
const PLIST = plistPath(HOME);
const ERR_LOG = "/xdg/state/titan-factory/serve.err.log";
const MCP_ADD = "claude mcp add --transport http --scope user titan-factory http://127.0.0.1:7410/mcp";
const OLD_PID = 100;
const GH_DOWN = "gh api rate_limit failed (1): gh: command not found";
const TOOLS: Record<string, string> = { gh: "/opt/tools/bin/gh", "agent-chat": "/srv/agents/bin/agent-chat", claude: "/opt/claude/bin/claude" };
const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const failed = (code: number, stderr: string): CommandResult => ({ code, stdout: "", stderr });

interface MachineInit {
  platform?: NodeJS.Platform;
  /** A job launchd already holds, running as OLD_PID and answering /health. */
  loaded?: boolean;
  /** Whether the process launchd starts ever answers /health. */
  serves?: boolean;
  /** Another process answering /health on the port, by pid. */
  stranger?: number;
  build?: { sha: string; behindMain: number | string };
  /** How many `print` calls still report the job after a bootout. */
  lingers?: number;
  claude?: CommandResult;
  /** Paths that exist as directories, for --claude-config-dir. */
  dirs?: string[];
  files?: Record<string, string>;
  /** Binaries `which` does not find. */
  absent?: string[];
  /** The `github` field of each /health answer in turn; the last one repeats. Defaults to `ok`. */
  github?: string[];
  /** launchd reports no pid for the job, and /health carries none either. */
  pidless?: boolean;
  /** The `busy` field of each /health answer in turn; the last one repeats. Absent leaves the field out, as an older build does. */
  busy?: BusyRun[][];
  /** `service.labelPrefix` from the factory config. */
  labelPrefix?: string;
}

/** A launchd that refuses to bootstrap a loaded label, as the real one does, so an install that skips bootout fails. */
function fakeMachine(init: MachineInit = {}) {
  const files = new Map(Object.entries(init.files ?? {}));
  const label = serviceLabel(init.labelPrefix);
  const TARGET = `gui/${UID}/${label}`;
  const calls: string[] = [];
  const dirs: string[] = [];
  const serves = init.serves ?? true;
  let lingers = 0;
  const github = [...(init.github ?? ["ok"])];
  const busy = init.busy && [...init.busy];
  let clock = 0;
  let job: { pid?: number; healthy: boolean } | undefined = init.loaded ? { pid: OLD_PID, healthy: true } : undefined;
  const start = (pid: number): CommandResult => {
    job = { ...(init.pidless ? {} : { pid }), healthy: serves };
    return ok();
  };
  const verbs: Record<string, () => CommandResult> = {
    print: () => {
      if (job) return ok(`${TARGET} = {\n\tstate = running\n${job.pid === undefined ? "" : `\tpid = ${job.pid}\n`}}\n`);
      return lingers-- > 0 ? ok(`${TARGET} = {\n\tstate = not running\n}\n`) : failed(113, `Could not find service "${label}" in domain for user gui: ${UID}`);
    },
    bootout: () => {
      job = undefined;
      lingers = init.lingers ?? 0;
      return ok();
    },
    bootstrap: () => (job || lingers > 0 ? failed(5, "Bootstrap failed: 5: Input/output error") : start(OLD_PID + 1)),
    kickstart: () => (job ? start((job.pid ?? OLD_PID) + 1) : failed(113, "Could not find service")),
  };
  const launchctl = async (args: readonly string[]): Promise<CommandResult> => {
    calls.push(`launchctl ${args.join(" ")}`);
    return verbs[args[0]!]!();
  };
  const ports: ServicePorts = {
    platform: init.platform ?? "darwin",
    uid: UID,
    home: HOME,
    ...(init.labelPrefix === undefined ? {} : { labelPrefix: init.labelPrefix }),
    launchctl,
    systemctl: async (args) => {
      calls.push(`systemctl ${args.join(" ")}`);
      return failed(127, "systemctl not found");
    },
    claude: async (args, env) => {
      calls.push(`${env?.CLAUDE_CONFIG_DIR ? `CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR} ` : ""}claude ${args.join(" ")}`);
      return init.claude;
    },
    isDirectory: (path) => init.dirs?.includes(path) ?? false,
    health: async (port) => {
      if (init.stranger !== undefined) return { ok: true, pid: init.stranger, port };
      if (!job?.healthy) return null;
      return { ok: true, ...(job.pid === undefined ? {} : { pid: job.pid }), port, version: "0.1.0", github: github.length > 1 ? github.shift() : github[0], pendingGates: 2, ...(init.build === undefined ? {} : { build: init.build }), ...(busy ? { busy: busy.length > 1 ? busy.shift() : busy[0] } : {}) };
    },
    which: (binary) => (init.absent?.includes(binary) ? undefined : TOOLS[binary]),
    mkdir: (dir) => void dirs.push(dir),
    writeFile: (path, text) => void files.set(path, text),
    readFile: (path) => files.get(path),
    exists: (path) => files.has(path),
    remove: (path) => void files.delete(path),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
  };
  return { ports, elapsed: () => clock, files, calls, dirs, launchctlCalls: () => calls.filter((call) => !call.startsWith("launchctl print")) };
}

async function service(argv: string[], machine: ReturnType<typeof fakeMachine>): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io = { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t), env: { XDG_STATE_HOME: "/xdg/state" } };
  const code = await runCli(["service", ...argv], io, { workflows: [], routes: [], service: machine.ports });
  return { code, out, err };
}

describe("titan-factory service install", () => {
  it("writes the plist, bootstraps it and reports the healthy port", async () => {
    const machine = fakeMachine();

    const { code, out } = await service(["install"], machine);

    expect(code).toBe(EXIT.OK);
    expect(machine.files.get(PLIST)).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(machine.dirs).toEqual(expect.arrayContaining(["/xdg/state/titan-factory", "/srv/tester/Library/LaunchAgents"]));
    expect(machine.launchctlCalls()).toEqual([`launchctl bootstrap gui/${UID} ${PLIST}`]);
    expect(out).toContain("/health answers on port 7410");
    expect(machine.calls.some((call) => call.startsWith("claude"))).toBe(false);
  });

  it("boots a loaded job out before bootstrapping the new plist", async () => {
    const machine = fakeMachine({ loaded: true, files: { [PLIST]: "stale" } });

    const { code, err } = await service(["install"], machine);

    expect(err).toBe("");
    expect(code).toBe(EXIT.OK);
    expect(machine.launchctlCalls()).toEqual([`launchctl bootout ${TARGET}`, `launchctl bootstrap gui/${UID} ${PLIST}`]);
    expect(machine.files.get(PLIST)).not.toBe("stale");
  });

  it("waits for launchd to let go of the label before bootstrapping", async () => {
    const machine = fakeMachine({ loaded: true, lingers: 2 });

    const { code } = await service(["install"], machine);

    expect(code).toBe(EXIT.OK);
  });

  it("exits non-zero pointing at the error log, without quoting its error text, when /health never answers", async () => {
    const machine = fakeMachine({ serves: false, files: { [ERR_LOG]: `line 1\n${LEAKY_MESSAGE}\n` } });

    const { code, out, err } = await service(["install", "--mcp"], machine);

    expect(code).toBe(EXIT.FAILURE);
    expect(out).toBe("");
    expect(err).toContain("did not answer /health on port 7410");
    expect(err).toContain(`tail -n 20 ${ERR_LOG}`);
    expectNoLeak(err);
    expect(machine.calls.some((call) => call.startsWith("claude"))).toBe(false);
  });

  it("says the error log is empty or missing when there is none to show", async () => {
    const { code, err } = await service(["install"], fakeMachine({ serves: false }));

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toContain(`${ERR_LOG} is empty or missing`);
  });

  it("fails when another process answers /health in place of the job", async () => {
    const { code, err } = await service(["install"], fakeMachine({ serves: false, stranger: 4242 }));

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toContain(`port 7410 is answered by pid 4242, not by ${SERVICE_LABEL}`);
  });

  it("reports a bootstrap launchd refuses", async () => {
    const machine = fakeMachine();
    machine.ports.launchctl = async (args) => (args[0] === "bootstrap" ? failed(5, "Bootstrap failed: 5: Input/output error") : failed(113, "not found"));

    const { code, err } = await service(["install"], machine);

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toContain("launchctl bootstrap failed: Bootstrap failed: 5");
  });

  it("puts --port in the plist and polls /health there", async () => {
    const machine = fakeMachine();

    const { code, out } = await service(["install", "--port", "7499", "--mcp"], machine);

    expect(code).toBe(EXIT.OK);
    expect(machine.files.get(PLIST)).toMatch(/<string>--port<\/string>\s*<string>7499<\/string>/);
    expect(out).toContain("port 7499");
    expect(machine.calls).toContain("claude mcp add --transport http --scope user titan-factory http://127.0.0.1:7499/mcp");
  });
});

describe("titan-factory service install: the job's PATH", () => {
  const pathOf = (plist: string | undefined): string[] => /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(plist ?? "")?.[1]?.split(":") ?? [];

  it("writes a plist whose PATH has the directories of gh, agent-chat, claude and node ahead of launchd's own", async () => {
    const machine = fakeMachine();

    const { code, err } = await service(["install", "--node", "/opt/node/bin/node"], machine);

    expect(code).toBe(EXIT.OK);
    expect(err).toBe("");
    expect(pathOf(machine.files.get(PLIST))).toEqual(["/opt/tools/bin", "/srv/agents/bin", "/opt/claude/bin", "/opt/node/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  });

  it("refuses a --node with a colon before touching launchd or the plist", async () => {
    const machine = fakeMachine({ loaded: true });

    const { code, err } = await service(["install", "--node", "/opt/x:rel/node"], machine);

    expect(code).toBe(EXIT.USAGE);
    expect(err).toContain('must not contain ":"');
    expect(machine.calls).toEqual([]);
    expect(machine.files.size).toBe(0);
  });

  it("fails before touching launchd or the plist when gh is not on PATH", async () => {
    const machine = fakeMachine({ loaded: true, absent: ["gh"] });

    const { code, err } = await service(["install"], machine);

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toContain("error: gh is not on PATH");
    expect(machine.calls).toEqual([]);
    expect(machine.files.size).toBe(0);
  });

  it("installs with a warning, and without its directory, when a dispatch binary is not on PATH", async () => {
    const machine = fakeMachine({ absent: ["agent-chat", "claude"] });

    const { code, err } = await service(["install", "--node", "/opt/node/bin/node"], machine);

    expect(code).toBe(EXIT.OK);
    expect(err).toBe("warning: agent-chat is not on PATH, so the service will not find it\nwarning: claude is not on PATH, so the service will not find it\n");
    expect(pathOf(machine.files.get(PLIST))).toEqual(["/opt/tools/bin", "/opt/node/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  });
});

describe("titan-factory service and the GitHub check", () => {
  it("install exits non-zero with one line when /health answers but its GitHub check failed", async () => {
    const machine = fakeMachine({ github: [GH_DOWN] });

    const { code, out, err } = await service(["install", "--mcp"], machine);

    expect(code).toBe(EXIT.FAILURE);
    expect(out).toBe("");
    expect(err).toBe(`error: titan-factory serve answers on port 7410 but its GitHub check failed: ${GH_DOWN}\n`);
    expect(machine.calls.some((call) => call.startsWith("claude"))).toBe(false);
  });

  it("install waits while serve is still checking GitHub", async () => {
    const passing = await service(["install"], fakeMachine({ github: ["checking", "checking", "ok"] }));
    const failing = await service(["install"], fakeMachine({ github: ["checking", GH_DOWN] }));

    expect(passing.code).toBe(EXIT.OK);
    expect(failing.code).toBe(EXIT.FAILURE);
    expect(failing.err).toContain(GH_DOWN);
  });

  it("install fails when the GitHub check never finishes", async () => {
    const { code, err } = await service(["install"], fakeMachine({ github: ["checking"] }));

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toContain("did not finish its GitHub check within 30 s");
  });

  it("restart exits non-zero when the restarted job cannot reach GitHub", async () => {
    const { code, err } = await service(["restart"], fakeMachine({ loaded: true, github: [GH_DOWN] }));

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toContain(`GitHub check failed: ${GH_DOWN}`);
  });

  it("status exits non-zero with one line when /health answers but its GitHub check failed", async () => {
    const { code, out, err } = await service(["status"], fakeMachine({ loaded: true, github: [GH_DOWN] }));

    expect(code).toBe(EXIT.FAILURE);
    expect(out).toContain("health: ok on port 7410");
    expect(err).toBe(`error: /health answers on port 7410 but its GitHub check is not ok: ${GH_DOWN}\n`);
  });

  it("status waits out checking, and fails when it never ends", async () => {
    const settled = await service(["status"], fakeMachine({ loaded: true, github: ["checking", "ok"] }));
    const stuck = await service(["status"], fakeMachine({ loaded: true, github: ["checking"] }));

    expect(settled.code).toBe(EXIT.OK);
    expect(settled.out).toContain("github ok");
    expect(stuck.code).toBe(EXIT.FAILURE);
    expect(stuck.err).toContain("GitHub check is not ok: checking");
  });
});

describe("titan-factory service: whose /health it is", () => {
  it("does not accept a /health with no pid for a job launchd reports no pid for", async () => {
    const install = await service(["install"], fakeMachine({ pidless: true }));
    const restart = await service(["restart"], fakeMachine({ loaded: true, pidless: true }));

    expect(install.code).toBe(EXIT.FAILURE);
    expect(install.err).toContain(`not by ${SERVICE_LABEL}`);
    expect(restart.code).toBe(EXIT.FAILURE);
  });
});

describe("titan-factory service install --mcp", () => {
  it("registers the MCP endpoint with claude at user scope", async () => {
    const machine = fakeMachine({ claude: ok("Added HTTP MCP server titan-factory") });

    const { code, out } = await service(["install", "--mcp"], machine);

    expect(code).toBe(EXIT.OK);
    expect(machine.calls).toContain(MCP_ADD);
    expect(out).toContain("registered titan-factory with claude");
  });

  it("names the config file it wrote when no dir is given", async () => {
    const { out } = await service(["install", "--mcp"], fakeMachine({ claude: ok() }));

    expect(out).toContain(`in ${HOME}/.claude.json\n`);
  });

  it("registers in every --claude-config-dir, each with its own printed file", async () => {
    const machine = fakeMachine({ claude: ok(), dirs: ["/p/one", "/p/two"] });

    const { code, out } = await service(["install", "--mcp", "--claude-config-dir", "/p/one", "--claude-config-dir", "/p/two"], machine);

    expect(code).toBe(EXIT.OK);
    expect(machine.calls).toContain(`CLAUDE_CONFIG_DIR=/p/one ${MCP_ADD}`);
    expect(machine.calls).toContain(`CLAUDE_CONFIG_DIR=/p/two ${MCP_ADD}`);
    expect(machine.calls).not.toContain(MCP_ADD);
    expect(out).toContain("in /p/one/.claude.json\n");
    expect(out).toContain("in /p/two/.claude.json\n");
  });

  it("fails before writing anything when a dir is missing or not a directory", async () => {
    const machine = fakeMachine({ claude: ok(), dirs: ["/p/one"] });

    const { code, err } = await service(["install", "--mcp", "--claude-config-dir", "/p/one", "--claude-config-dir", "/p/nope"], machine);

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toContain("--claude-config-dir /p/nope is not a directory");
    expect(machine.calls).toEqual([]);
    expect(machine.files.size).toBe(0);
  });

  it("still succeeds without a claude binary, and prints the command to run by hand", async () => {
    const { code, err } = await service(["install", "--mcp"], fakeMachine({ claude: undefined }));

    expect(code).toBe(EXIT.OK);
    expect(err).toContain("no claude binary on PATH");
    expect(err).toContain(`\n  ${MCP_ADD}\n`);
  });

  it("treats an already registered server as success", async () => {
    const machine = fakeMachine({ claude: failed(1, "MCP server titan-factory already exists in user config") });

    const { code, out, err } = await service(["install", "--mcp"], machine);

    expect(code).toBe(EXIT.OK);
    expect(err).toBe("");
    expect(out).toContain("already registered");
  });

  it("prints the command to run by hand when claude fails", async () => {
    const { code, err } = await service(["install", "--mcp"], fakeMachine({ claude: failed(1, "config is locked") }));

    expect(code).toBe(EXIT.OK);
    expect(err).toContain("claude mcp add failed: config is locked");
    expect(err).toContain(`\n  ${MCP_ADD}\n`);
  });
});

describe("titan-factory service uninstall", () => {
  it("boots the loaded job out and removes the plist", async () => {
    const machine = fakeMachine({ loaded: true, files: { [PLIST]: "<plist/>" } });

    const { code, out } = await service(["uninstall"], machine);

    expect(code).toBe(EXIT.OK);
    expect(machine.launchctlCalls()).toEqual([`launchctl bootout ${TARGET}`]);
    expect(machine.files.has(PLIST)).toBe(false);
    expect(out).toContain(`removed ${PLIST}`);
  });

  it("removes the plist of a job that is not loaded, without a bootout", async () => {
    const machine = fakeMachine({ files: { [PLIST]: "<plist/>" } });

    const { code } = await service(["uninstall"], machine);

    expect(code).toBe(EXIT.OK);
    expect(machine.launchctlCalls()).toEqual([]);
    expect(machine.files.has(PLIST)).toBe(false);
  });

  it("says so when nothing was installed", async () => {
    const { code, out } = await service(["uninstall"], fakeMachine());

    expect(code).toBe(EXIT.OK);
    expect(out).toContain("was not installed");
  });

  it("keeps the plist and fails when launchd never lets go of the job", async () => {
    const machine = fakeMachine({ loaded: true, lingers: Number.POSITIVE_INFINITY, files: { [PLIST]: "<plist/>" } });

    const { code, err } = await service(["uninstall"], machine);

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toContain("still loaded after launchctl bootout");
    expect(machine.files.has(PLIST)).toBe(true);
  });
});

describe("titan-factory service status", () => {
  it("prints the loaded job, its pid and a health summary, and exits 0 when healthy", async () => {
    const { code, out } = await service(["status"], fakeMachine({ loaded: true }));

    expect(code).toBe(EXIT.OK);
    expect(out).toBe(`${SERVICE_LABEL}: loaded, pid ${OLD_PID}\nhealth: ok on port 7410 (pid ${OLD_PID}, version 0.1.0, github ok, pendingGates 2)\n`);
  });

  it("prints the build sha and how many commits behind main it is", async () => {
    const build = { sha: "0123456789abcdef0123-dirty", behindMain: 7 };
    const { out } = await service(["status"], fakeMachine({ loaded: true, build }));

    expect(out).toContain("build 0123456789ab-dirty, 7 behind main)");
  });

  it("prints the reason when the behind count is not a number", async () => {
    const build = { sha: "unknown", behindMain: "checking" };
    const { out } = await service(["status"], fakeMachine({ loaded: true, build }));

    expect(out).toContain("build unknown, behind main: checking)");
  });

  it("exits non-zero when /health is down, loaded or not", async () => {
    const unloaded = await service(["status"], fakeMachine());
    const machine = fakeMachine({ loaded: true, serves: false });
    await service(["restart"], machine);
    const unhealthy = await service(["status", "--port", "7499"], machine);

    expect(unloaded.code).toBe(EXIT.FAILURE);
    expect(unloaded.out).toBe(`${SERVICE_LABEL}: not loaded\nhealth: no answer on port 7410\n`);
    expect(unhealthy.code).toBe(EXIT.FAILURE);
    expect(unhealthy.out).toBe(`${SERVICE_LABEL}: loaded, pid ${OLD_PID + 1}\nhealth: no answer on port 7499\n`);
  });
});

describe("titan-factory service restart", () => {
  it("kickstarts the job and waits for the new process to answer /health", async () => {
    const machine = fakeMachine({ loaded: true });

    const { code, out } = await service(["restart"], machine);

    expect(code).toBe(EXIT.OK);
    expect(machine.launchctlCalls()).toEqual([`launchctl kickstart -k ${TARGET}`]);
    expect(out).toContain("restarted");
  });

  it("fails pointing at the error log when the restarted job never answers", async () => {
    const machine = fakeMachine({ loaded: true, serves: false, files: { [ERR_LOG]: "EADDRINUSE\n" } });

    const { code, err } = await service(["restart"], machine);

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toContain(`tail -n 20 ${ERR_LOG}`);
  });

  it("waits for a busy review to finish before it kickstarts", async () => {
    const review: BusyRun = { runId: "run-1", step: "sh-await-verdict:abc1234", phase: "review" };
    const machine = fakeMachine({ loaded: true, busy: [[review], [review], []] });

    const { code, out } = await service(["restart"], machine);

    expect(code).toBe(EXIT.OK);
    expect(out).toContain("waiting for 1 busy run(s) before restarting:\n  run-1 sh-await-verdict:abc1234 (review)");
    expect(machine.launchctlCalls()).toEqual([`launchctl kickstart -k ${TARGET}`]);
  });

  it("refuses without a kickstart when a park-routed step outlasts --drain-timeout", async () => {
    const machine = fakeMachine({ loaded: true, busy: [[{ runId: "run-2", step: "post-merge", phase: "park" }]] });

    const { code, err } = await service(["restart", "--drain-timeout", "2m"], machine);

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toContain("rerun with --force");
    expect(machine.elapsed()).toBe(120_000);
    expect(machine.launchctlCalls()).toEqual([]);
  });

  it("kickstarts over a busy park-routed step with --no-drain --force", async () => {
    const machine = fakeMachine({ loaded: true, busy: [[{ runId: "run-2", step: "post-merge", phase: "park" }]] });

    const { code } = await service(["restart", "--no-drain", "--force"], machine);

    expect(code).toBe(EXIT.OK);
    expect(machine.elapsed()).toBe(0);
    expect(machine.launchctlCalls()).toEqual([`launchctl kickstart -k ${TARGET}`]);
  });

  it("rejects a --drain-timeout without a unit", async () => {
    const { code, err } = await service(["restart", "--drain-timeout", "45"], fakeMachine({ loaded: true }));

    expect(code).toBe(EXIT.USAGE);
    expect(err).toContain("expected a duration such as 45m");
  });

  it("points at install when the job is not loaded", async () => {
    const { code, err } = await service(["restart"], fakeMachine());

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toContain("titan-factory service install loads the job");
  });
});

describe("titan-factory service off macOS and Linux", () => {
  it.each(["install", "uninstall", "status", "restart"])("%s fails with one line and touches nothing", async (verb) => {
    const machine = fakeMachine({ platform: "win32", loaded: true });

    const { code, out, err } = await service([verb], machine);

    expect(code).toBe(EXIT.FAILURE);
    expect(out).toBe("");
    expect(err).toBe(`error: titan-factory service ${verb} needs launchd (macOS) or systemd (Linux) (this is win32)\n`);
    expect(machine.calls).toEqual([]);
    expect(machine.files.size).toBe(0);
  });

  it("plist still prints", async () => {
    const { code, out } = await service(["plist"], fakeMachine({ platform: "win32" }));

    expect(code).toBe(EXIT.OK);
    expect(out).toContain(`<string>${SERVICE_LABEL}</string>`);
  });
});

describe("titan-factory service with service.labelPrefix", () => {
  const PREFIX = "dev.ex.";
  const CUSTOM_LABEL = "dev.ex.titan-factory";
  const CUSTOM_TARGET = `gui/${UID}/${CUSTOM_LABEL}`;
  const CUSTOM_PLIST = plistPath(HOME, PREFIX);

  it("installs, reports status and uninstalls under the configured label", async () => {
    const machine = fakeMachine({ labelPrefix: PREFIX });

    const install = await service(["install"], machine);
    const status = await service(["status"], machine);
    const uninstall = await service(["uninstall"], machine);

    expect([install.code, status.code, uninstall.code]).toEqual([EXIT.OK, EXIT.OK, EXIT.OK]);
    expect(CUSTOM_PLIST).toBe(`${HOME}/Library/LaunchAgents/${CUSTOM_LABEL}.plist`);
    expect(machine.calls).toEqual(expect.arrayContaining([`launchctl bootstrap gui/${UID} ${CUSTOM_PLIST}`, `launchctl print ${CUSTOM_TARGET}`, `launchctl bootout ${CUSTOM_TARGET}`]));
    expect(machine.calls.filter((call) => call.includes(SERVICE_LABEL))).toEqual([]);
    expect(status.out).toContain(`${CUSTOM_LABEL}: loaded`);
    expect(uninstall.out).toBe(`uninstalled ${CUSTOM_LABEL}; removed ${CUSTOM_PLIST}\n`);
    expect(machine.files.has(CUSTOM_PLIST)).toBe(false);
  });

  it("writes the configured label into the plist", async () => {
    const machine = fakeMachine({ labelPrefix: PREFIX });

    await service(["install"], machine);

    expect(machine.files.get(CUSTOM_PLIST)).toContain(`<string>${CUSTOM_LABEL}</string>`);
    expect(machine.files.get(CUSTOM_PLIST)).not.toContain(SERVICE_LABEL);
  });

  it("restarts the configured job with kickstart", async () => {
    const machine = fakeMachine({ labelPrefix: PREFIX, loaded: true });

    await service(["restart"], machine);

    expect(machine.calls).toContain(`launchctl kickstart -k ${CUSTOM_TARGET}`);
  });
});
