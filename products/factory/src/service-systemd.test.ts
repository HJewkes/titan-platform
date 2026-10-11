import { describe, expect, it } from "vitest";
import { EXIT, runCli } from "./cli.js";
import { UNIT_NAME, unitPath } from "./service.js";
import type { CommandResult, ServicePorts } from "./service-control.js";

const HOME = "/srv/tester";
const DEPLOY_CHECKOUT = `${HOME}/.local/share/titan-factory/deploy/titan-platform`;
const DEPLOY_BIN = `${DEPLOY_CHECKOUT}/products/factory/dist/bin.js`;
const UNIT = unitPath(HOME);
const OLD_PID = 100;
const TOOLS: Record<string, string> = { gh: "/opt/tools/bin/gh", "agent-chat": "/srv/agents/bin/agent-chat", claude: "/opt/claude/bin/claude" };
const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const failed = (code: number, stderr: string): CommandResult => ({ code, stdout: "", stderr });

interface MachineInit {
  /** A unit systemd already runs as OLD_PID, its file written and reloaded. */
  running?: boolean;
  /** The process systemd starts never answers /health. */
  silent?: boolean;
  enableFails?: boolean;
  xdgConfigHome?: string;
}

/** A systemd --user manager that only knows a unit file as of its last daemon-reload, as the real one does. */
function fakeSystemd(init: MachineInit = {}) {
  const file = init.xdgConfigHome ? unitPath(HOME, init.xdgConfigHome) : UNIT;
  const files = new Map<string, string>(init.running ? [[file, "old unit"]] : []);
  const calls: string[] = [];
  let known = init.running === true;
  let pid: number | undefined = init.running ? OLD_PID : undefined;
  let nextPid = OLD_PID + 1;
  const start = (): CommandResult => {
    pid = nextPid++;
    return ok();
  };
  const show = (): string =>
    known ? `LoadState=loaded\nActiveState=${pid ? "active" : "inactive"}\nSubState=${pid ? "running" : "dead"}\nMainPID=${pid ?? 0}\n` : "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n";
  const verbs: Record<string, () => CommandResult> = {
    show: () => ok(show()),
    "daemon-reload": () => {
      known = files.has(file);
      return ok();
    },
    enable: () => {
      if (!known || init.enableFails) return failed(1, `Failed to enable unit: Unit file ${UNIT_NAME} does not exist.`);
      return pid === undefined ? start() : ok();
    },
    restart: () => (known ? start() : failed(5, `Failed to restart ${UNIT_NAME}: Unit ${UNIT_NAME} not found.`)),
    disable: () => {
      pid = undefined;
      return ok();
    },
  };
  const systemctl = async (args: readonly string[]): Promise<CommandResult> => {
    calls.push(`systemctl ${args.join(" ")}`);
    if (args[0] !== "--user") return failed(1, "Failed to connect to bus: not the user manager");
    return verbs[args[1]!]!();
  };
  const ports: ServicePorts = {
    platform: "linux",
    uid: 1000,
    home: HOME,
    ...(init.xdgConfigHome ? { xdgConfigHome: init.xdgConfigHome } : {}),
    launchctl: async (args) => {
      calls.push(`launchctl ${args.join(" ")}`);
      return failed(127, "launchctl not found");
    },
    systemctl,
    claude: async () => undefined,
    isDirectory: () => false,
    which: (binary) => TOOLS[binary],
    health: async (port) => (pid === undefined || init.silent ? null : { ok: true, pid, port, github: "ok" }),
    mkdir: () => undefined,
    writeFile: (path, text) => void files.set(path, text),
    readFile: (path) => files.get(path),
    exists: (path) => files.has(path) || path === DEPLOY_BIN,
    remove: (path) => void files.delete(path),
    sleep: async () => undefined,
    now: () => 0,
  };
  return { ports, files, calls, mutations: () => calls.filter((call) => !call.includes(" show ")) };
}

async function service(argv: string[], machine: ReturnType<typeof fakeSystemd>): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io = { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t), env: { XDG_STATE_HOME: "/xdg/state" } };
  const code = await runCli(["service", ...argv], io, { workflows: [], routes: [], service: machine.ports });
  return { code, out, err };
}

describe("titan-factory service install on Linux", () => {
  it("writes the unit, enables and starts it, and waits for /health", async () => {
    const machine = fakeSystemd();

    const { code, out, err } = await service(["install"], machine);

    expect(err).toBe("");
    expect(code).toBe(EXIT.OK);
    expect(machine.files.get(UNIT)).toContain("ExecStart=");
    expect(machine.files.get(UNIT)).toContain(`${DEPLOY_BIN} serve`);
    expect(machine.files.get(UNIT)).toContain(`WorkingDirectory=${DEPLOY_CHECKOUT}`);
    expect(machine.mutations()).toEqual(["systemctl --user daemon-reload", `systemctl --user enable --now ${UNIT_NAME}`]);
    expect(out).toBe(`installed ${UNIT_NAME} from ${UNIT}; /health answers on port 7410\n`);
  });

  it("restarts a running unit so it picks up the new unit text", async () => {
    const machine = fakeSystemd({ running: true });

    const { code } = await service(["install"], machine);

    expect(code).toBe(EXIT.OK);
    expect(machine.files.get(UNIT)).not.toBe("old unit");
    expect(machine.mutations()).toEqual(["systemctl --user daemon-reload", `systemctl --user enable --now ${UNIT_NAME}`, `systemctl --user restart ${UNIT_NAME}`]);
  });

  it("writes under XDG_CONFIG_HOME when it is set", async () => {
    const machine = fakeSystemd({ xdgConfigHome: "/xdg/config" });

    expect((await service(["install"], machine)).code).toBe(EXIT.OK);

    expect([...machine.files.keys()]).toEqual(["/xdg/config/systemd/user/titan-factory.service"]);
  });

  it("reports a failed enable with systemctl's own words", async () => {
    const { code, err } = await service(["install"], fakeSystemd({ enableFails: true }));

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toBe(`error: systemctl enable failed: Failed to enable unit: Unit file ${UNIT_NAME} does not exist.\n`);
  });

  it("fails when the started unit never answers /health", async () => {
    const { code, err } = await service(["install"], fakeSystemd({ silent: true }));

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toContain("did not answer /health on port 7410");
  });

  it("with --dry-run prints the unit and the systemctl calls, and changes nothing", async () => {
    const machine = fakeSystemd({ running: true });

    const { code, out } = await service(["install", "--dry-run"], machine);

    expect(code).toBe(EXIT.OK);
    expect(out).toMatch(new RegExp(`^dry run: would write ${UNIT}:\n\\[Unit\\]\n`));
    expect(out).toContain("WantedBy=default.target\nthen run:\n  systemctl --user daemon-reload\n");
    expect(out).toContain(`  systemctl --user restart ${UNIT_NAME}\n`);
    expect(machine.mutations()).toEqual([]);
    expect(machine.files.get(UNIT)).toBe("old unit");
  });

  it("never runs launchctl", async () => {
    const machine = fakeSystemd();

    await service(["install"], machine);
    await service(["status"], machine);
    await service(["restart", "--no-drain"], machine);
    await service(["uninstall"], machine);

    expect(machine.calls.filter((call) => call.startsWith("launchctl"))).toEqual([]);
  });
});

describe("titan-factory service status on Linux", () => {
  it("shows the active state and MainPID with the /health summary", async () => {
    const { code, out } = await service(["status"], fakeSystemd({ running: true }));

    expect(code).toBe(EXIT.OK);
    expect(out).toBe(`${UNIT_NAME}: active (running), pid ${OLD_PID}\nhealth: ok on port 7410 (pid ${OLD_PID}, github ok)\n`);
  });

  it("says not loaded when systemd has no unit file", async () => {
    const { code, out } = await service(["status"], fakeSystemd());

    expect(code).toBe(EXIT.FAILURE);
    expect(out).toBe(`${UNIT_NAME}: not loaded\nhealth: no answer on port 7410\n`);
  });
});

describe("titan-factory service uninstall and restart on Linux", () => {
  it("disables and stops the unit, removes its file and reloads systemd", async () => {
    const machine = fakeSystemd({ running: true });

    const { code, out } = await service(["uninstall"], machine);

    expect(code).toBe(EXIT.OK);
    expect(machine.mutations()).toEqual([`systemctl --user disable --now ${UNIT_NAME}`, "systemctl --user daemon-reload"]);
    expect(machine.files.size).toBe(0);
    expect(out).toBe(`uninstalled ${UNIT_NAME}; removed ${UNIT}\n`);
  });

  it("says so when nothing was installed, and runs nothing", async () => {
    const machine = fakeSystemd();

    const { code, out } = await service(["uninstall"], machine);

    expect(code).toBe(EXIT.OK);
    expect(out).toBe(`${UNIT_NAME} was not installed\n`);
    expect(machine.mutations()).toEqual([]);
  });

  it("restarts the unit through systemctl and waits for the new pid on /health", async () => {
    const machine = fakeSystemd({ running: true });

    const { code, out } = await service(["restart", "--no-drain"], machine);

    expect(code).toBe(EXIT.OK);
    expect(machine.mutations()).toEqual([`systemctl --user restart ${UNIT_NAME}`]);
    expect(out).toContain(`restarted ${UNIT_NAME}; /health answers on port 7410\n`);
  });

  it("points at install when no unit is loaded", async () => {
    const { code, err } = await service(["restart", "--no-drain"], fakeSystemd());

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toBe(`error: systemctl restart failed: Failed to restart ${UNIT_NAME}: Unit ${UNIT_NAME} not found.; titan-factory service install loads the job\n`);
  });
});

describe("titan-factory service plist on Linux", () => {
  it("prints the systemd unit", async () => {
    const { code, out } = await service(["plist", "--node", "/opt/node/bin/node"], fakeSystemd());

    expect(code).toBe(EXIT.OK);
    expect(out).toMatch(/^\[Unit\]\n/);
    expect(out).toContain("ExecStart=/opt/node/bin/node ");
    expect(out).toContain("Environment=PATH=/opt/tools/bin:/srv/agents/bin:/opt/claude/bin:/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin\n");
  });
});
