import { describe, expect, it } from "vitest";
import type { OwnerItemDeposit } from "@titan-design/owner-queue";
import { closureDirs, touchedPaths } from "./plan.js";
import { verdictLine, type NodeRun } from "./release-smoke.js";
import { EXIT, lockPath, readRecord, recordPath, selfUpdate, type CommandResult, type UpdateOptions, type UpdatePorts } from "./update.js";

const ROOT = "/srv/console";
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const RELEASE = `${ROOT}/releases/${NEW}`;
const OPTIONS: UpdateOptions = { root: ROOT, stateDir: "/state", port: 7500, unit: "titan-console.service" };
const CLOSURE = JSON.stringify([
  { name: "titan-console", path: `${ROOT}/checkout/apps/console` },
  { name: "@titan-design/daemon", path: `${ROOT}/checkout/packages/daemon` },
]);

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const failed = (stderr: string): CommandResult => ({ code: 1, stdout: "", stderr });
const ran = (run: Partial<NodeRun>): NodeRun => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...run });
const verdict = (why?: string): NodeRun => ran({ code: why === undefined ? 0 : 1, stdout: `boot line\n${verdictLine(why)}\n` });

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
  /** What the new release's own `self-update --smoke` does. */
  releaseSmoke?: NodeRun;
  /** What this updater's in-process smoke says, used only for a release without the verb. */
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
    runNode: async (script, args) => (calls.push(`node ${script} ${args.join(" ")}`), scenario.releaseSmoke ?? verdict()),
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
    expect(fake.calls).toContain(`node ${RELEASE}/apps/console/dist/cli.js self-update --smoke ${RELEASE} ${NEW}`);
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
    const fake = fakePorts({ releaseSmoke: verdict("the new build on spare port 40123 answered /health with nothing") });
    expect(await selfUpdate(fake.ports, OPTIONS)).toBe(EXIT.FAILED);
    expect(served(fake)).toBe(`${ROOT}/checkout`);
    expect(fake.calls.some((call) => call.startsWith("systemctl"))).toBe(false);
    expect(fake.alarms).toHaveLength(1);
    expect(fake.alarms[0]).toMatchObject({ asker: "titan-console", kind: "do", keys: ["console-update"] });
    expect(fake.alarms[0]!.context).toContain("aaaaaaa keeps serving");
    expect(record(fake)?.why).toBe("the new build on spare port 40123 answered /health with nothing");
  });

  // TP-3938: the installed updater's own smoke was broken, so the release carrying its fix never got past it.
  it("runs the new release's smoke check, not the one in the updater that is running", async () => {
    const fake = fakePorts({ smoke: "the old check bound a port the served console holds", releaseSmoke: verdict() });

    expect(await selfUpdate(fake.ports, OPTIONS)).toBe(EXIT.OK);

    expect(served(fake)).toBe(RELEASE);
    expect(fake.calls.some((call) => call.startsWith("smoke "))).toBe(false);
  });

  it("falls back to its own smoke check when the new release has no smoke verb", async () => {
    const usage = ran({ code: 64, stderr: "usage: titan-console                    serve the console\n" });
    const fake = fakePorts({ releaseSmoke: usage, smoke: "the new build on spare port 40123 did not serve its page at /" });

    expect(await selfUpdate(fake.ports, OPTIONS)).toBe(EXIT.FAILED);

    expect(fake.calls).toContain(`smoke ${RELEASE}`);
    expect(record(fake)).toMatchObject({ stage: "smoke", why: "the new build on spare port 40123 did not serve its page at /" });
  });

  // TP-3935: the smoke child's output was discarded, so the owner saw "answered with nothing" and not the EADDRINUSE.
  it("puts the end of a crashed smoke check's stderr in the record and the alarm", async () => {
    const noise = Array.from({ length: 30 }, (_, n) => `noise line ${n}`).join("\n");
    const crash = ran({ code: 1, stderr: `${noise}\nError: listen EADDRINUSE: address already in use 127.0.0.1:7501\n` });
    const fake = fakePorts({ releaseSmoke: crash });

    expect(await selfUpdate(fake.ports, OPTIONS)).toBe(EXIT.FAILED);

    const why = record(fake)?.why ?? "";
    expect(why).toMatch(/^the new build's smoke check exited 1 with no verdict; its stderr ended: /);
    expect(why).toContain("EADDRINUSE: address already in use 127.0.0.1:7501");
    expect(why).toContain("noise line 11");
    expect(why).not.toContain("noise line 10");
    expect(fake.alarms[0]!.context).toContain("EADDRINUSE");
    expect(served(fake)).toBe(`${ROOT}/checkout`);
  });

  it("fails the smoke stage when the new release's check runs past its time, even with a late verdict", async () => {
    const fake = fakePorts({ releaseSmoke: ran({ ...verdict(), timedOut: true, stderr: "still waiting on /health" }) });

    expect(await selfUpdate(fake.ports, OPTIONS)).toBe(EXIT.FAILED);

    expect(record(fake)).toMatchObject({ stage: "smoke", why: "the new build's smoke check did not finish in time; its stderr ended: still waiting on /health" });
    expect(fake.calls.some((call) => call.startsWith("smoke ") || call.startsWith("systemctl"))).toBe(false);
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
