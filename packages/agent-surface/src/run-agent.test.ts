import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { itermIdentity, hashedColour, parseHex, oscTitle } from "./pane-identity.js";
import { launchEnv } from "./run-agent.js";
import type { LaunchPlan } from "./types.js";

/**
 * The launcher against the built bin: real processes, a real plan on disk, and
 * a fake claude that is just a node script. `PATH=/usr/bin:/bin` stands in for a
 * host started with a minimal PATH.
 */

const DIST = path.join(import.meta.dirname, "..", "dist");
const BIN = path.join(DIST, "bin.js");
const MINIMAL_PATH = "/usr/bin:/bin";

let stateDir: string;
let fakeClaude: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-surface-launch-"));
  fakeClaude = path.join(stateDir, "fake-claude.js");
  fs.writeFileSync(fakeClaude, "process.stdout.write('fake-claude-ran')\n");
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const agentDir = () => path.join(stateDir, "agents", "agt-test");
const planFile = () => path.join(agentDir(), "plan.json");
const tailFile = () => path.join(agentDir(), "stderr-tail.txt");

function writePlan(env: Record<string, string> = {}, stdin?: string, extra: Partial<LaunchPlan> = {}): void {
  const plan: LaunchPlan = {
    agentId: "agt-test",
    bin: process.execPath,
    args: [fakeClaude],
    cwd: stateDir,
    env,
    title: "agt-test",
    surface: "headless",
    ...(stdin === undefined ? {} : { stdin }),
    ...extra,
  };
  fs.mkdirSync(agentDir(), { recursive: true });
  fs.writeFileSync(planFile(), JSON.stringify(plan));
}

const launch = (env: Record<string, string> = {}, flags: string[] = []) =>
  spawnSync(process.execPath, [BIN, ...flags, planFile()], {
    encoding: "utf8",
    env: { ...env, PATH: MINIMAL_PATH },
  });

/** Runs `runAgent` from the built entry in a child, so its `process.exit` ends that child and not the test. */
const launchWithResolver = (resolver: string) =>
  spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { runAgent, readLaunchPlan, LaunchBinUnresolved } from ${JSON.stringify(path.join(DIST, "index.js"))};
       const plan = readLaunchPlan(${JSON.stringify(planFile())});
       runAgent(plan, { agentDir: ${JSON.stringify(agentDir())}, resolveBin: ${resolver} });`,
    ],
    { encoding: "utf8", env: { PATH: MINIMAL_PATH } },
  );

describe("the environment the launcher hands the launched process", () => {
  it("stamps its own pid over a launcher pid the plan tries to set", () => {
    const merged = launchEnv({ TITAN_AGENT_LAUNCHER_PID: "1", AGENT_NAME: "scout" }, { HOME: "/h" }, 4242);

    expect(merged).toEqual({ HOME: "/h", AGENT_NAME: "scout", TITAN_AGENT_LAUNCHER_PID: "4242" });
  });

  it("deletes a variable the plan marks unset, even when the host carried it", () => {
    const merged = launchEnv({}, { HOME: "/h", CLAUDE_CONFIG_DIR: "/h/.claude" }, 4242, ["CLAUDE_CONFIG_DIR"]);

    expect(merged).toEqual({ HOME: "/h", TITAN_AGENT_LAUNCHER_PID: "4242" });
  });
});

describe("the launcher resolving the binary it execs", () => {
  it("execs an absolute bin from the plan without a usable PATH", () => {
    writePlan();

    const result = launch();

    expect(result.stdout).toBe("fake-claude-ran");
    expect(result.status).toBe(0);
  });

  it("execs what the host's resolver returns rather than the plan's bare name", () => {
    writePlan({}, undefined, { bin: "claude" });

    const result = launchWithResolver(`() => ${JSON.stringify(process.execPath)}`);

    expect(result.stdout).toBe("fake-claude-ran");
    expect(result.status).toBe(0);
  });

  it("exits 127 with the resolver's reason when the bin cannot be resolved", () => {
    writePlan({}, undefined, { bin: "claude" });

    const result = launchWithResolver(`() => { throw new LaunchBinUnresolved("no claude on this machine") }`);

    expect(result.status).toBe(127);
    expect(result.stderr).toContain("titan-agent-launch: no claude on this machine");
  });
});

describe("the launcher stamping the launched process", () => {
  const reportsLauncher = (name: string) =>
    fs.writeFileSync(fakeClaude, `process.stdout.write(JSON.stringify([process.env.${name}, String(process.ppid)]))\n`);

  it("hands the launched process its own pid as the launcher, over anything the plan says", () => {
    reportsLauncher("TITAN_AGENT_LAUNCHER_PID");
    writePlan({ TITAN_AGENT_LAUNCHER_PID: "1" });

    const [launcher, parent] = JSON.parse(launch().stdout) as [string, string];

    expect(launcher).toBe(parent);
  });

  it("stamps the variable the host names, for a host whose hooks read their own", () => {
    reportsLauncher("HOST_LAUNCHER_PID");
    writePlan({ HOST_LAUNCHER_PID: "1" });

    const [launcher, parent] = JSON.parse(launch({}, ["--launcher-pid-env", "HOST_LAUNCHER_PID"]).stdout) as [
      string,
      string,
    ];

    expect(launcher).toBe(parent);
  });
});

describe("the launcher honouring an unset marker in the plan", () => {
  // The deletion must not be gated on the surface: only a headless plan was ever tested once.
  it.each(["headless", "iterm-pane", "iterm-tab"] as const)(
    "launches claude on %s with CLAUDE_CONFIG_DIR absent, though its own environment had one",
    surface => {
      const seen = path.join(stateDir, "seen.txt");
      fs.writeFileSync(
        fakeClaude,
        `require('node:fs').writeFileSync(${JSON.stringify(seen)}, String('CLAUDE_CONFIG_DIR' in process.env))\n`,
      );
      writePlan({}, undefined, { surface, unsetEnv: ["CLAUDE_CONFIG_DIR"] });

      launch({ CLAUDE_CONFIG_DIR: stateDir });

      expect(fs.readFileSync(seen, "utf8")).toBe("false");
    },
  );
});

describe("the launcher's pane escapes", () => {
  const ITERM = { TERM_PROGRAM: "iTerm.app" };

  it("writes the exact iTerm bytes before claude starts in a tab", () => {
    writePlan({}, undefined, { surface: "iterm-tab", title: "ac-task-1" });
    const rgb = parseHex(hashedColour("ac"));
    const expected = oscTitle("ac-task-1") + (rgb === undefined ? "" : itermIdentity("ac-task-1", rgb));

    expect(launch(ITERM).stdout).toBe(`${expected}fake-claude-ran`);
  });

  it("writes no escape bytes before a headless claude", () => {
    writePlan({}, undefined, { surface: "headless", title: "ac-task-1" });

    expect(launch(ITERM).stdout).toBe("fake-claude-ran");
  });
});

describe("the launcher keeping the stderr tail of a headless claude", () => {
  it("leaves only the bounded tail of what claude wrote to stderr, and still passes it on", () => {
    fs.writeFileSync(
      fakeClaude,
      "process.stdin.resume(); process.stderr.write('x'.repeat(100000) + 'Not logged in · Please run /login\\n'); process.exitCode = 1\n",
    );
    writePlan({}, "the brief");

    const result = launch();

    const tail = fs.readFileSync(tailFile(), "utf8");
    expect(tail).toMatch(/Not logged in · Please run \/login\n$/);
    expect(tail.length).toBeLessThanOrEqual(4096);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Not logged in");
  });

  it("writes no tail file when claude says nothing on stderr", () => {
    writePlan({}, "the brief");

    launch();

    expect(fs.existsSync(tailFile())).toBe(false);
  });

  it("exits promptly when a grandchild keeps holding claude's stderr", () => {
    fs.writeFileSync(
      fakeClaude,
      "process.stdin.resume(); require('node:child_process').spawn('sleep', ['4'], { stdio: ['ignore', 'ignore', 'inherit'], detached: true }).unref(); process.stderr.write('Not logged in\\n'); process.exitCode = 3\n",
    );
    writePlan({}, "the brief");

    const started = Date.now();
    const result = launch();

    expect(Date.now() - started).toBeLessThan(2500);
    expect(result.status).toBe(3);
    expect(fs.readFileSync(tailFile(), "utf8")).toContain("Not logged in");
  });

  it("waits for stderr that lands just after claude exits, so the tail keeps it", () => {
    fs.writeFileSync(
      fakeClaude,
      "process.stdin.resume(); require('node:child_process').spawn(process.execPath, ['-e', \"setTimeout(() => process.stderr.write('late words\\\\n'), 100)\"], { stdio: ['ignore', 'ignore', 'inherit'], detached: true }).unref(); process.exitCode = 2\n",
    );
    writePlan({}, "the brief");

    const result = launch();

    expect(result.status).toBe(2);
    expect(fs.readFileSync(tailFile(), "utf8")).toContain("late words");
  });

  it("exits with the claude exit code when claude closes stdin before reading its brief", () => {
    fs.writeFileSync(fakeClaude, "process.stdin.destroy(); process.exit(7)\n");
    writePlan({}, "x".repeat(4 * 1024 * 1024));

    const result = launch();

    expect(result.status).toBe(7);
    expect(result.stderr).not.toMatch(/EPIPE|Unhandled|node:events/);
  });

  it("discards a tail left by an earlier launch of the same agent", () => {
    fs.mkdirSync(agentDir(), { recursive: true });
    fs.writeFileSync(tailFile(), "Not logged in\n");
    writePlan({}, "the brief");

    launch();

    expect(fs.existsSync(tailFile())).toBe(false);
  });
});

describe("the launcher's command line", () => {
  it("refuses a missing plan file with a usage-class exit", () => {
    const result = spawnSync(process.execPath, [BIN, path.join(stateDir, "absent.json")], { encoding: "utf8" });

    expect(result.status).toBe(66);
    expect(result.stderr).toContain("no launch plan at");
  });

  it("refuses extra arguments rather than guessing which is the plan", () => {
    writePlan();

    const result = spawnSync(process.execPath, [BIN, planFile(), "stray"], { encoding: "utf8" });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("usage: titan-agent-launch");
  });
});
