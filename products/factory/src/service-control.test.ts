import { describe, expect, it } from "vitest";
import { EXIT, runCli } from "./cli.js";
import { plistPath, SERVICE_LABEL } from "./service.js";
import type { CommandResult, ServicePorts } from "./service-control.js";

const HOME = "/srv/tester";
const UID = 501;
const TARGET = `gui/${UID}/${SERVICE_LABEL}`;
const PLIST = plistPath(HOME);
const ERR_LOG = "/xdg/state/titan-factory/serve.err.log";
const MCP_ADD = "claude mcp add --transport http --scope user titan-factory http://127.0.0.1:7410/mcp";
const OLD_PID = 100;
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
  /** How many `print` calls still report the job after a bootout. */
  lingers?: number;
  claude?: CommandResult;
  files?: Record<string, string>;
}

/** A launchd that refuses to bootstrap a loaded label, as the real one does, so an install that skips bootout fails. */
function fakeMachine(init: MachineInit = {}) {
  const files = new Map(Object.entries(init.files ?? {}));
  const calls: string[] = [];
  const dirs: string[] = [];
  const serves = init.serves ?? true;
  let lingers = 0;
  let job = init.loaded ? { pid: OLD_PID, healthy: true } : undefined;
  const start = (pid: number): CommandResult => {
    job = { pid, healthy: serves };
    return ok();
  };
  const verbs: Record<string, () => CommandResult> = {
    print: () => {
      if (job) return ok(`${TARGET} = {\n\tstate = running\n\tpid = ${job.pid}\n}\n`);
      return lingers-- > 0 ? ok(`${TARGET} = {\n\tstate = not running\n}\n`) : failed(113, `Could not find service "${SERVICE_LABEL}" in domain for user gui: ${UID}`);
    },
    bootout: () => {
      job = undefined;
      lingers = init.lingers ?? 0;
      return ok();
    },
    bootstrap: () => (job || lingers > 0 ? failed(5, "Bootstrap failed: 5: Input/output error") : start(OLD_PID + 1)),
    kickstart: () => (job ? start(job.pid + 1) : failed(113, "Could not find service")),
  };
  const launchctl = async (args: readonly string[]): Promise<CommandResult> => {
    calls.push(`launchctl ${args.join(" ")}`);
    return verbs[args[0]!]!();
  };
  const ports: ServicePorts = {
    platform: init.platform ?? "darwin",
    uid: UID,
    home: HOME,
    launchctl,
    claude: async (args) => {
      calls.push(`claude ${args.join(" ")}`);
      return init.claude;
    },
    health: async (port) => {
      if (init.stranger !== undefined) return { ok: true, pid: init.stranger, port };
      return job?.healthy ? { ok: true, pid: job.pid, port, version: "0.1.0", github: "ok", pendingGates: 2 } : null;
    },
    mkdir: (dir) => void dirs.push(dir),
    writeFile: (path, text) => void files.set(path, text),
    readFile: (path) => files.get(path),
    exists: (path) => files.has(path),
    remove: (path) => void files.delete(path),
    sleep: async () => undefined,
  };
  return { ports, files, calls, dirs, launchctlCalls: () => calls.filter((call) => !call.startsWith("launchctl print")) };
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

  it("exits non-zero with the tail of the error log when /health never answers", async () => {
    const log = Array.from({ length: 30 }, (_, line) => `line ${line + 1}`).join("\n");
    const machine = fakeMachine({ serves: false, files: { [ERR_LOG]: `${log}\n` } });

    const { code, out, err } = await service(["install", "--mcp"], machine);

    expect(code).toBe(EXIT.FAILURE);
    expect(out).toBe("");
    expect(err).toContain("did not answer /health on port 7410");
    expect(err).toContain(`--- tail of ${ERR_LOG}\nline 11\n`);
    expect(err).toMatch(/line 30\n$/);
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

describe("titan-factory service install --mcp", () => {
  it("registers the MCP endpoint with claude at user scope", async () => {
    const machine = fakeMachine({ claude: ok("Added HTTP MCP server titan-factory") });

    const { code, out } = await service(["install", "--mcp"], machine);

    expect(code).toBe(EXIT.OK);
    expect(machine.calls).toContain(MCP_ADD);
    expect(out).toContain("registered titan-factory with claude");
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

  it("fails with the error log tail when the restarted job never answers", async () => {
    const machine = fakeMachine({ loaded: true, serves: false, files: { [ERR_LOG]: "EADDRINUSE\n" } });

    const { code, err } = await service(["restart"], machine);

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toContain("EADDRINUSE");
  });

  it("points at install when the job is not loaded", async () => {
    const { code, err } = await service(["restart"], fakeMachine());

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toContain("titan-factory service install loads the job");
  });
});

describe("titan-factory service off macOS", () => {
  it.each(["install", "uninstall", "status", "restart"])("%s fails with one line and touches nothing", async (verb) => {
    const machine = fakeMachine({ platform: "linux", loaded: true });

    const { code, out, err } = await service([verb], machine);

    expect(code).toBe(EXIT.FAILURE);
    expect(out).toBe("");
    expect(err).toBe(`error: titan-factory service ${verb} needs launchd, which only macOS has (this is linux)\n`);
    expect(machine.calls).toEqual([]);
    expect(machine.files.size).toBe(0);
  });

  it("plist still prints", async () => {
    const { code, out } = await service(["plist"], fakeMachine({ platform: "linux" }));

    expect(code).toBe(EXIT.OK);
    expect(out).toContain(`<string>${SERVICE_LABEL}</string>`);
  });
});
