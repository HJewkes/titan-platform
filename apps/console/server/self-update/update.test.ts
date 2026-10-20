import { describe, expect, it } from "vitest";
import type { OwnerItemDeposit } from "@titan-design/owner-queue";
import { closureDirs, touchedPaths } from "./plan.js";
import { EXIT, lockPath, readRecord, recordPath, selfUpdate, type CommandResult, type UpdateOptions, type UpdatePorts } from "./update.js";

const ROOT = "/srv/console";
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const OPTIONS: UpdateOptions = { root: ROOT, stateDir: "/state", port: 7500, unit: "titan-console.service" };
const CLOSURE = JSON.stringify([
  { name: "titan-console", path: `${ROOT}/checkout/apps/console` },
  { name: "@titan-design/daemon", path: `${ROOT}/checkout/packages/daemon` },
]);

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const failed = (stderr: string): CommandResult => ({ code: 1, stdout: "", stderr });

interface Fake {
  ports: UpdatePorts;
  files: Map<string, string>;
  links: Map<string, string>;
  calls: string[];
  alarms: OwnerItemDeposit[];
  /** The build sha the served unit answers after each restart, in order. */
  restarts: (string | null | undefined)[];
}

interface Scenario {
  changed?: string[];
  build?: CommandResult;
  smoke?: string;
  afterRestart?: (string | null | undefined)[];
  liveHolder?: number;
}

function fakePorts(scenario: Scenario = {}): Fake {
  const files = new Map<string, string>();
  const links = new Map([[`${ROOT}/current`, `${ROOT}/checkout`]]);
  const calls: string[] = [];
  const alarms: OwnerItemDeposit[] = [];
  const restarts = [...(scenario.afterRestart ?? [NEW])];
  const git = async (cwd: string, args: readonly string[]): Promise<CommandResult> => {
    calls.push(`git ${args.join(" ")}`);
    if (args[0] === "rev-parse") return ok(`${args[3] === "origin/main^{commit}" ? NEW : cwd.includes("releases/") ? NEW : OLD}\n`);
    if (args[0] === "diff") return ok((scenario.changed ?? ["apps/console/src/App.tsx"]).join("\n"));
    return ok();
  };
  const pnpm = async (_cwd: string, args: readonly string[]): Promise<CommandResult> => {
    calls.push(`pnpm ${args.join(" ")}`);
    if (args.includes("ls")) return ok(CLOSURE);
    return args.includes("build") ? (scenario.build ?? ok()) : ok();
  };
  const ports: UpdatePorts = {
    pid: 100,
    git,
    pnpm,
    systemctl: async (args) => (calls.push(`systemctl ${args.join(" ")}`), ok()),
    readLink: (link) => links.get(link),
    swapLink: (link, target) => (calls.push(`swap ${target}`), void links.set(link, target)),
    exists: (file) => files.has(file),
    listDirs: () => [OLD, NEW, "c".repeat(40)],
    mkdir: () => {},
    writeFile: (file, text) => void files.set(file, text),
    readFile: (file) => files.get(file),
    remove: (file) => void files.delete(file),
    createExclusive: (file, text) => (files.has(file) ? false : (files.set(file, text), true)),
    isAlive: (pid) => pid === scenario.liveHolder,
    smoke: async (release) => (calls.push(`smoke ${release}`), scenario.smoke),
    servedSha: async () => restarts.shift(),
    alarm: async (deposit) => void alarms.push(deposit),
    log: () => {},
    now: () => Date.parse("2031-03-05T12:00:00.000Z"),
  };
  return { ports, files, links, calls, alarms, restarts };
}

const record = (fake: Fake) => readRecord(fake.files.get(recordPath(OPTIONS.stateDir)));
const served = (fake: Fake) => fake.links.get(`${ROOT}/current`);

describe("the console self-update", () => {
  it("does nothing when no commit since the served sha touches the console closure", async () => {
    const fake = fakePorts({ changed: ["products/factory/src/serve.ts", "apps/console/README.md", "packages/daemon/src/http.test.ts"] });
    expect(await selfUpdate(fake.ports, OPTIONS)).toBe(EXIT.OK);
    expect(fake.calls.filter((call) => /worktree add|install|build|restart|swap/.test(call))).toEqual([]);
    expect(served(fake)).toBe(`${ROOT}/checkout`);
  });

  it("builds, smokes, swaps and restarts when a closure package changed, then keeps two releases", async () => {
    const fake = fakePorts({ changed: ["packages/daemon/src/http.ts"] });
    expect(await selfUpdate(fake.ports, OPTIONS)).toBe(EXIT.OK);
    expect(served(fake)).toBe(`${ROOT}/releases/${NEW}`);
    expect(fake.calls).toContain(`smoke ${ROOT}/releases/${NEW}`);
    expect(fake.calls).toContain("systemctl --user restart titan-console.service");
    expect(fake.calls.filter((call) => call.startsWith("git worktree remove"))).toEqual([`git worktree remove --force ${ROOT}/releases/${OLD}`, `git worktree remove --force ${ROOT}/releases/${"c".repeat(40)}`]);
    expect(record(fake)).toMatchObject({ outcome: "updated", target: NEW, served: OLD });
  });

  it("keeps the old sha serving when the build fails, and raises the alarm", async () => {
    const fake = fakePorts({ build: failed("vite: Could not resolve ./BuildFooter.js") });
    expect(await selfUpdate(fake.ports, OPTIONS)).toBe(EXIT.FAILED);
    expect(served(fake)).toBe(`${ROOT}/checkout`);
    expect(fake.calls.some((call) => call.startsWith("systemctl") || call.startsWith("smoke"))).toBe(false);
    expect(record(fake)).toMatchObject({ outcome: "failed", stage: "build", target: NEW });
    expect(fake.alarms.map((alarm) => alarm.depositId)).toEqual(["console-update-bbbbbbb-build"]);
  });

  it("keeps the old sha serving when the smoke check fails, and raises the alarm", async () => {
    const fake = fakePorts({ smoke: "the new build on spare port 40123 answered /health with nothing" });
    expect(await selfUpdate(fake.ports, OPTIONS)).toBe(EXIT.FAILED);
    expect(served(fake)).toBe(`${ROOT}/checkout`);
    expect(fake.calls.some((call) => call.startsWith("systemctl"))).toBe(false);
    expect(fake.alarms).toHaveLength(1);
    expect(fake.alarms[0]).toMatchObject({ asker: "titan-console", kind: "do", keys: ["console-update"] });
    expect(fake.alarms[0]!.context).toContain("aaaaaaa keeps serving");
  });

  it("swaps the old build back when the restarted unit does not answer as the new sha", async () => {
    const fake = fakePorts({ afterRestart: [undefined, null] });
    expect(await selfUpdate(fake.ports, OPTIONS)).toBe(EXIT.FAILED);
    expect(served(fake)).toBe(`${ROOT}/checkout`);
    expect(fake.calls.filter((call) => call.startsWith("systemctl"))).toHaveLength(2);
    expect(record(fake)).toMatchObject({ outcome: "rolled-back", stage: "restart" });
    expect(fake.alarms.map((alarm) => alarm.depositId)).toEqual(["console-update-bbbbbbb-restart"]);
  });

  it("says the console may be down when the rollback does not answer either", async () => {
    const fake = fakePorts({ afterRestart: [undefined, undefined] });
    expect(await selfUpdate(fake.ports, OPTIONS)).toBe(EXIT.FAILED);
    expect(record(fake)).toMatchObject({ outcome: "rollback-failed", stage: "rollback" });
    expect(fake.alarms[0]!.summary).toMatch(/^CONSOLE MAY BE DOWN/);
  });

  it("holds a failed target instead of rebuilding it on every tick", async () => {
    const fake = fakePorts({ build: failed("boom") });
    await selfUpdate(fake.ports, OPTIONS);
    fake.calls.length = 0;
    expect(await selfUpdate(fake.ports, OPTIONS)).toBe(EXIT.OK);
    expect(fake.calls.some((call) => call.includes("build") || call.includes("worktree add"))).toBe(false);
  });

  it("refuses a second run while another holds the lock", async () => {
    const fake = fakePorts({ liveHolder: 4242 });
    fake.files.set(lockPath(OPTIONS.stateDir), "4242");
    expect(await selfUpdate(fake.ports, OPTIONS)).toBe(EXIT.LOCKED);
    expect(fake.calls).toEqual([]);
    expect(fake.files.get(lockPath(OPTIONS.stateDir))).toBe("4242");
  });

  it("takes over a lock whose holder is gone and releases it after", async () => {
    const fake = fakePorts({ changed: [] });
    fake.files.set(lockPath(OPTIONS.stateDir), "4242");
    expect(await selfUpdate(fake.ports, OPTIONS)).toBe(EXIT.OK);
    expect(fake.files.has(lockPath(OPTIONS.stateDir))).toBe(false);
  });

  it("is a no-op when the served sha is already origin/main", async () => {
    const fake = fakePorts();
    fake.links.set(`${ROOT}/current`, `${ROOT}/releases/${NEW}`);
    expect(await selfUpdate(fake.ports, OPTIONS)).toBe(EXIT.OK);
    expect(fake.calls.filter((call) => !call.startsWith("git fetch") && !call.startsWith("git rev-parse"))).toEqual([]);
  });

  it("refuses until the current symlink exists", async () => {
    const fake = fakePorts();
    fake.links.clear();
    expect(await selfUpdate(fake.ports, OPTIONS)).toBe(EXIT.CONFIG);
    expect(fake.calls).toEqual([]);
  });
});

describe("the console closure", () => {
  it("reads pnpm's package paths relative to the checkout", () => {
    expect(closureDirs(CLOSURE, `${ROOT}/checkout`)).toEqual(["apps/console", "packages/daemon"]);
    expect(closureDirs("not json", ROOT)).toBeUndefined();
  });

  it("counts root build inputs and runtime files, not tests or docs, and keeps every path when the closure is unknown", () => {
    const changed = ["pnpm-lock.yaml", "tsconfig.base.json", "packages/daemon/src/x.ts", "packages/daemon/src/x.test.ts", "packages/pm/src/y.ts", "apps/console/CHANGELOG.md"];
    expect(touchedPaths(changed, ["apps/console", "packages/daemon"])).toEqual(["pnpm-lock.yaml", "tsconfig.base.json", "packages/daemon/src/x.ts"]);
    expect(touchedPaths(changed, undefined)).toEqual(changed);
  });
});
