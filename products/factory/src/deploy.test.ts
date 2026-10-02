import { describe, expect, it } from "vitest";
import { EXIT, runCli } from "./cli.js";
import { deployRecordPath, deployService, parseDeployRecord, type DeployOptions, type DeployPorts } from "./deploy.js";
import { SERVICE_LABEL } from "./service.js";
import type { CommandResult } from "./service-control.js";

const CHECKOUT = "/srv/repo";
const STATE = "/xdg/state/titan-factory";
const UID = 501;
const TARGET = `gui/${UID}/${SERVICE_LABEL}`;
const OLD_PID = 100;
const DEPLOYER_PID = 4242;
const [BASE, DOCS, CORE, TIP] = ["1", "2", "3", "4"].map((digit) => digit.repeat(40)) as [string, string, string, string];
const STRAY = "f".repeat(40);
const HISTORY = [BASE, DOCS, CORE, TIP];
const CHANGES: Record<string, string[]> = { [DOCS]: ["README.md"], [CORE]: ["products/factory/src/serve.ts"], [TIP]: ["site/guides/factory.md"] };
const FACTORY_DIST = `${CHECKOUT}/products/factory/dist`;
const WORKFLOW_DIST = `${CHECKOUT}/packages/workflow/dist`;
const CHARTS_DIST = `${CHECKOUT}/packages/charts/dist`;
const RECORD = deployRecordPath(STATE);
const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const failed = (code: number, stderr: string): CommandResult => ({ code, stdout: "", stderr });

const WORKSPACE_FILES: Record<string, string> = {
  [`${CHECKOUT}/pnpm-workspace.yaml`]: 'packages:\n  - "packages/*"\n  - "products/*"\n',
  [`${CHECKOUT}/products/factory/package.json`]: JSON.stringify({ name: "@titan-design/factory", dependencies: { "@titan-design/workflow": "workspace:^" } }),
  [`${CHECKOUT}/packages/workflow/package.json`]: JSON.stringify({ name: "@titan-design/workflow" }),
  [`${CHECKOUT}/packages/charts/package.json`]: JSON.stringify({ name: "@titan-design/charts" }),
};
const WORKSPACE_DIRS: Record<string, string[]> = { [`${CHECKOUT}/packages`]: ["workflow", "charts"], [`${CHECKOUT}/products`]: ["factory"] };

interface MachineInit {
  branch?: string;
  dirty?: string;
  /** The sha the running service was built from; `null` leaves /health unanswered. */
  running?: string | null;
  head?: string;
  files?: Record<string, string>;
  installFails?: boolean;
  buildFails?: boolean;
  /** Builds of these shas crash on start, so /health never answers for them. */
  crashes?: string[];
  /** Pids `isAlive` reports as running. */
  alive?: number[];
}

const at = (sha: string): number => HISTORY.indexOf(sha);
const resolveRef = (ref: string): string | undefined => (ref === "origin/main" ? TIP : at(ref) >= 0 ? ref : undefined);

function fakeGit(state: { head: string }, init: MachineInit): (args: readonly string[]) => CommandResult {
  const ancestor = (a: string, b: string): boolean => {
    const [ia, ib] = [at(a), at(resolveRef(b) ?? "")];
    return ia >= 0 && ib >= 0 && ia <= ib;
  };
  const verbs: Record<string, (args: readonly string[]) => CommandResult> = {
    "symbolic-ref": () => ok(`${init.branch ?? "main"}\n`),
    status: () => ok(init.dirty ?? ""),
    fetch: () => ok(),
    "rev-parse": (args) => {
      if (args[1] === "HEAD") return ok(`${state.head}\n`);
      const sha = resolveRef(args[3]!.replace("^{commit}", ""));
      return sha ? ok(`${sha}\n`) : failed(1, "");
    },
    "merge-base": (args) => (ancestor(args[2]!, args[3]!) ? ok() : failed(1, "")),
    diff: (args) => {
      const [from, to] = [at(args[3]!), at(args[4]!)];
      if (from < 0 || to < 0) return failed(128, "fatal: bad object");
      return ok(HISTORY.slice(from + 1, to + 1).flatMap((sha) => CHANGES[sha] ?? []).join("\n"));
    },
    merge: (args) => {
      if (at(args[2]!) > at(state.head)) state.head = args[2]!;
      return ok();
    },
  };
  return (args) => verbs[args[0]!]?.(args) ?? failed(1, `unexpected git ${args.join(" ")}`);
}

/** A launchd whose kickstart loads whatever build sits in products/factory/dist at that moment. */
function fakeMachine(init: MachineInit = {}) {
  const files = new Map(Object.entries({ ...WORKSPACE_FILES, ...init.files }));
  const running = init.running === undefined ? BASE : init.running;
  const trees = new Map<string, string>([FACTORY_DIST, WORKFLOW_DIST, CHARTS_DIST].map((dist) => [dist, `build:${running ?? BASE}`]));
  const state = { head: init.head ?? BASE };
  const calls: string[] = [];
  let clock = 0;
  let job = { pid: OLD_PID, serving: running };
  const git = fakeGit(state, init);
  const kickstart = (): CommandResult => {
    const sha = trees.get(FACTORY_DIST)?.replace("build:", "") ?? null;
    job = { pid: job.pid + 1, serving: sha !== null && !init.crashes?.includes(sha) ? sha : null };
    return ok();
  };
  const pnpm = (args: readonly string[]): CommandResult => {
    if (args[0] === "install") return init.installFails ? failed(1, "ERR_PNPM_OUTDATED_LOCKFILE") : ok();
    if (init.buildFails) {
      trees.delete(FACTORY_DIST);
      return failed(2, "src/serve.ts(1,1): error TS2304");
    }
    for (const dist of [FACTORY_DIST, WORKFLOW_DIST]) trees.set(dist, `build:${state.head}`);
    return ok();
  };
  const under = (key: string, path: string): boolean => key === path || key.startsWith(`${path}/`);
  const ports: DeployPorts = {
    platform: "darwin",
    uid: UID,
    home: "/srv/tester",
    pid: DEPLOYER_PID,
    launchctl: async (args) => {
      if (args[0] !== "print") calls.push(`launchctl ${args.join(" ")}`);
      if (args[0] === "kickstart") return kickstart();
      return ok(`${TARGET} = {\n\tpid = ${job.pid}\n}\n`);
    },
    git: async (args) => {
      calls.push(`git ${args.join(" ")}`);
      return git(args);
    },
    pnpm: async (args) => {
      calls.push(`pnpm ${args.join(" ")}`);
      return pnpm(args);
    },
    claude: async () => undefined,
    isDirectory: () => false,
    which: (binary) => `/opt/tools/bin/${binary}`,
    health: async () => (job.serving === null ? null : { ok: true, pid: job.pid, github: "ok", build: { sha: job.serving, behindMain: 0 }, busy: [] }),
    mkdir: () => undefined,
    writeFile: (path, text) => void files.set(path, text),
    readFile: (path) => files.get(path),
    exists: (path) => files.has(path) || trees.has(path),
    remove: (path) => void files.delete(path),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    listDirs: (dir) => WORKSPACE_DIRS[dir] ?? [],
    copyTree: (from, to) => [...trees].filter(([key]) => under(key, from)).forEach(([key, value]) => trees.set(to + key.slice(from.length), value)),
    removeTree: (path) => [...trees.keys()].filter((key) => under(key, path)).forEach((key) => trees.delete(key)),
    createExclusive: (path, text) => !files.has(path) && files.set(path, text) !== undefined,
    isAlive: (pid) => init.alive?.includes(pid) ?? false,
  };
  const record = () => parseDeployRecord(files.get(RECORD));
  const mutations = () => calls.filter((call) => /^(git (merge --|reset)|pnpm|launchctl)/.test(call));
  return { ports, calls, files, trees, state, record, mutations, serving: () => job.serving };
}

const OPTIONS: DeployOptions = { checkout: CHECKOUT, stateDir: STATE, port: 7410, logDir: STATE, drain: { timeoutMs: 60_000, wait: true, force: false } };

async function deploy(machine: ReturnType<typeof fakeMachine>, expect?: string): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io = { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t) };
  const code = await deployService(machine.ports, io, { ...OPTIONS, ...(expect === undefined ? {} : { expect }) });
  return { code, out, err };
}

describe("titan-factory service deploy", () => {
  it("fast-forwards, installs frozen, builds the factory closure, restarts and confirms the new sha", async () => {
    const machine = fakeMachine();

    const { code, err } = await deploy(machine);

    expect(err).toBe("");
    expect(code).toBe(0);
    expect(machine.mutations()).toEqual([`git merge --ff-only ${TIP}`, "pnpm install --frozen-lockfile", "pnpm --filter @titan-design/factory... build", `launchctl kickstart -k ${TARGET}`]);
    expect(machine.serving()).toBe(TIP);
    expect(machine.record()).toMatchObject({ outcome: "deployed", target: TIP, from: BASE, touched: ["products/factory/src/serve.ts"] });
    expect(machine.trees.get(`${STATE}/deploy-backup/${BASE}/products/factory/dist`)).toBe(`build:${BASE}`);
    expect(machine.trees.has(`${STATE}/deploy-backup/${BASE}/packages/charts/dist`)).toBe(false);
    expect(machine.files.has(`${STATE}/deploy.lock`)).toBe(false);
  });

  it("fast-forwards an untouched range without building or restarting, and records skipped", async () => {
    const machine = fakeMachine();

    const { code } = await deploy(machine, DOCS);

    expect(code).toBe(0);
    expect(machine.mutations()).toEqual([`git merge --ff-only ${DOCS}`]);
    expect(machine.state.head).toBe(DOCS);
    expect(machine.record()).toMatchObject({ outcome: "skipped", target: DOCS, from: BASE, touched: [] });
  });

  it.each([
    ["the deployed sha", CORE],
    ["an ancestor of the deployed sha", DOCS],
  ])("does nothing for %s", async (_name, expected) => {
    const machine = fakeMachine({ running: CORE, head: CORE });

    const { code, out } = await deploy(machine, expected);

    expect(code).toBe(0);
    expect(out).toContain(`already deployed: build ${CORE}`);
    expect(machine.mutations()).toEqual([]);
    expect(machine.record()).toBeUndefined();
  });

  it.each([
    ["is off main", { branch: "feature/x" }, "HEAD is feature/x, not main"],
    ["has tracked changes", { dirty: " M package.json\n" }, "tracked changes"],
  ])("refuses when the checkout %s, before fetching", async (_name, init, why) => {
    const machine = fakeMachine(init);

    const { code, err } = await deploy(machine);

    expect(code).toBe(1);
    expect(err).toContain("checkout not clean main");
    expect(machine.calls.filter((call) => call.startsWith("git fetch") || call.startsWith("git merge"))).toEqual([]);
    expect(machine.record()).toMatchObject({ outcome: "refused" });
    expect(machine.record()?.why).toContain(why);
  });

  it("refuses an --expect sha that is not on origin/main", async () => {
    const machine = fakeMachine();

    const { code, err } = await deploy(machine, STRAY);

    expect(code).toBe(1);
    expect(err).toContain(`${STRAY} is not a commit`);
    expect(machine.mutations()).toEqual([]);
  });

  it.each([
    ["install", { installFails: true }, "pnpm install --frozen-lockfile failed"],
    ["build", { buildFails: true }, "pnpm --filter @titan-design/factory... build failed"],
  ])("restores the dist snapshot without restarting the still-running service when the %s fails", async (_step, init, why) => {
    const failing = fakeMachine(init);

    const result = await deploy(failing);

    expect(result.code).toBe(1);
    expect(failing.trees.get(FACTORY_DIST)).toBe(`build:${BASE}`);
    expect(failing.serving()).toBe(BASE);
    expect(failing.mutations().some((call) => call.startsWith("launchctl"))).toBe(false);
    expect(failing.record()).toMatchObject({ outcome: "rolled-back", target: TIP, from: BASE, why: expect.stringContaining(why) });
    expect(failing.record()?.why).not.toContain("did not answer");
    expect(failing.calls.some((call) => call.startsWith("git reset"))).toBe(false);
  });

  it("restores the old build when the new one never answers /health, and confirms the old sha answers", async () => {
    const machine = fakeMachine({ crashes: [TIP] });

    const { code, err } = await deploy(machine);

    expect(code).toBe(1);
    expect(err).toContain("restoring the factory build");
    expect(machine.mutations().filter((call) => call.startsWith("launchctl kickstart"))).toHaveLength(2);
    expect(machine.serving()).toBe(BASE);
    expect(machine.state.head).toBe(TIP);
    expect(machine.record()).toMatchObject({ outcome: "rolled-back", target: TIP, why: "the restarted service did not come up healthy" });
    expect(machine.calls.some((call) => call.startsWith("git reset"))).toBe(false);
  });

  it("holds a sha that already rolled back until a newer one arrives", async () => {
    const rolledBack = { outcome: "rolled-back", target: TIP, from: BASE, at: "2026-10-02T00:00:00.000Z", why: "build failed" };
    const machine = fakeMachine({ files: { [RECORD]: JSON.stringify(rolledBack) } });

    const { code, err } = await deploy(machine);

    expect(code).toBe(1);
    expect(err).toContain(`deploy held: ${TIP} rolled back`);
    expect(machine.mutations()).toEqual([]);
    expect(machine.record()).toEqual(rolledBack);
  });

  it("deploys when /health does not answer, since an unknown build counts as touched", async () => {
    const machine = fakeMachine({ running: null });

    const { code } = await deploy(machine, DOCS);

    expect(code).toBe(0);
    expect(machine.record()).toMatchObject({ outcome: "deployed", target: DOCS, from: "unknown", touched: ["<unknown diff>"] });
  });

  it("refuses while another live deployer holds the lock", async () => {
    const machine = fakeMachine({ files: { [`${STATE}/deploy.lock`]: "777" }, alive: [777] });

    const { code, err } = await deploy(machine);

    expect(code).toBe(1);
    expect(err).toContain("another deploy is running (pid 777");
    expect(machine.calls).toEqual([]);
  });

  it("takes over a lock whose pid is gone", async () => {
    const machine = fakeMachine({ files: { [`${STATE}/deploy.lock`]: "777" } });

    const { code } = await deploy(machine);

    expect(code).toBe(0);
    expect(machine.files.has(`${STATE}/deploy.lock`)).toBe(false);
  });
});

describe("titan-factory service deploy verb", () => {
  async function cli(argv: string[], machine: ReturnType<typeof fakeMachine>): Promise<{ code: number; err: string }> {
    let err = "";
    const io = { stdout: () => undefined, stderr: (t: string) => void (err += t), env: { XDG_STATE_HOME: "/xdg/state" } };
    const code = await runCli(["service", "deploy", ...argv], io, { workflows: [], routes: [], deploy: machine.ports });
    return { code, err };
  }

  it("rejects an --expect value that is not a hex sha", async () => {
    const machine = fakeMachine();

    const { code, err } = await cli(["--expect", "main"], machine);

    expect(code).toBe(EXIT.USAGE);
    expect(err).toContain("expected a commit sha");
    expect(machine.calls).toEqual([]);
  });

  it("refuses off macOS before touching git", async () => {
    const machine = fakeMachine();
    machine.ports.platform = "linux";

    const { code, err } = await cli([], machine);

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toContain("needs launchd");
    expect(machine.calls).toEqual([]);
  });
});
