import { describe, expect, it } from "vitest";
import type { OwnerItemDeposit } from "@titan-design/owner-queue";
import { closureDirs, touchedPaths } from "./plan.js";
import { verdictLine, type NodeRun } from "./release-smoke.js";
import { applyRelease, EXIT, lockPath, readRecord, recordPath, reportRecorded, type CommandResult, type UpdateOptions, type UpdatePorts } from "./update.js";

const ROOT = "/srv/console";
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const STALE = "c".repeat(40);
const RELEASE = `${ROOT}/releases/${NEW}`;
const PREV = `${ROOT}/releases/${OLD}`;
const OPTIONS: UpdateOptions = { root: ROOT, stateDir: "/state", port: 7500, unit: "titan-console.service" };
const CLOSURE = JSON.stringify([
  { name: "titan-console", path: `${RELEASE}/apps/console` },
  { name: "@titan-design/daemon", path: `${RELEASE}/packages/daemon` },
]);

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const ran = (run: Partial<NodeRun>): NodeRun => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...run });
const verdict = (why?: string): NodeRun => ran({ code: why === undefined ? 0 : 1, stdout: `boot line\n${verdictLine(why)}\n` });

interface Fake {
  ports: UpdatePorts;
  files: Map<string, string>;
  links: Map<string, string>;
  calls: string[];
  alarms: OwnerItemDeposit[];
}

interface Scenario {
  changed?: string[];
  /** What the new release's own `self-update --smoke` does. */
  releaseSmoke?: NodeRun;
  /** What this updater's in-process smoke says, used only for a release without the verb. */
  smoke?: string;
  /** The build sha the served unit answers after each restart, in order. */
  afterRestart?: (string | null | undefined)[];
  liveHolder?: number;
  /** Where `current` points before the pass. */
  serving?: string;
}

function fakePorts(scenario: Scenario = {}): Fake {
  const files = new Map([[`${RELEASE}/apps/console/dist/cli.js`, "built"]]);
  const links = new Map([[`${ROOT}/current`, scenario.serving ?? PREV]]);
  const calls: string[] = [];
  const alarms: OwnerItemDeposit[] = [];
  const restarts = [...(scenario.afterRestart ?? [NEW])];
  const git = async (cwd: string, args: readonly string[]): Promise<CommandResult> => {
    calls.push(`git ${args.join(" ")}`);
    if (args[0] === "rev-parse") return ok(`${cwd.endsWith(NEW) ? NEW : OLD}\n`);
    if (args[0] === "diff") return ok((scenario.changed ?? ["apps/console/src/App.tsx"]).join("\n"));
    return ok();
  };
  const ports: UpdatePorts = {
    pid: 100,
    git,
    pnpm: async (_cwd, args) => (calls.push(`pnpm ${args.join(" ")}`), ok(args.includes("ls") ? CLOSURE : "")),
    systemctl: async (args) => (calls.push(`systemctl ${args.join(" ")}`), ok()),
    readLink: (link) => links.get(link),
    swapLink: (link, target) => (calls.push(`swap ${target}`), void links.set(link, target)),
    exists: (file) => [...files.keys()].some((key) => key === file || key.startsWith(`${file}/`)),
    listDirs: () => [OLD, NEW, STALE],
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
  return { ports, files, links, calls, alarms };
}

const record = (fake: Fake) => readRecord(fake.files.get(recordPath(OPTIONS.stateDir)));
const served = (fake: Fake) => fake.links.get(`${ROOT}/current`);
const removed = (fake: Fake) => fake.calls.filter((call) => call.startsWith("git worktree remove")).map((call) => call.split(" ").at(-1));
const apply = (fake: Fake) => applyRelease(fake.ports, OPTIONS, NEW);

describe("the console updater the bootstrap hands off to", () => {
  it("records a sha with no console change and drops its release without a restart", async () => {
    const fake = fakePorts({ changed: ["products/factory/src/serve.ts", "apps/console/README.md", "packages/daemon/src/http.test.ts"] });

    expect(await apply(fake)).toBe(EXIT.OK);

    expect(fake.calls.filter((call) => /restart|swap|--smoke/.test(call))).toEqual([]);
    expect(served(fake)).toBe(PREV);
    expect(record(fake)).toMatchObject({ outcome: "unchanged", target: NEW, served: OLD });
    expect(removed(fake)).toEqual([RELEASE]);
  });

  it("smokes, swaps and restarts a good build, then keeps it and the previous release", async () => {
    const fake = fakePorts({ changed: ["packages/daemon/src/http.ts"] });

    expect(await apply(fake)).toBe(EXIT.OK);

    expect(served(fake)).toBe(RELEASE);
    expect(fake.calls).toContain(`node ${RELEASE}/apps/console/dist/cli.js self-update --smoke ${RELEASE} ${NEW}`);
    expect(fake.calls).toContain("systemctl --user restart titan-console.service");
    expect(removed(fake)).toEqual([`${ROOT}/releases/${STALE}`]);
    expect(record(fake)).toMatchObject({ outcome: "updated", target: NEW, served: OLD });
  });

  it("rolls back to the previous release, still on disk, when /health does not report the new sha", async () => {
    const fake = fakePorts({ afterRestart: [OLD, OLD] });

    expect(await apply(fake)).toBe(EXIT.FAILED);

    expect(fake.calls.filter((call) => call.startsWith("swap"))).toEqual([`swap ${RELEASE}`, `swap ${PREV}`]);
    expect(served(fake)).toBe(PREV);
    expect(removed(fake)).toEqual([]);
    expect(fake.calls.filter((call) => call.startsWith("systemctl"))).toHaveLength(2);
    expect(record(fake)).toMatchObject({ outcome: "rolled-back", stage: "restart", why: `/health on port 7500 answered build ${OLD}, not ${NEW}` });
    expect(fake.alarms.map((alarm) => alarm.depositId)).toEqual(["console-update-bbbbbbb-restart"]);
  });

  it("accepts a rollback to a build from before the stamp that answers with no sha", async () => {
    const fake = fakePorts({ serving: `${ROOT}/checkout`, afterRestart: [undefined, null] });

    expect(await apply(fake)).toBe(EXIT.FAILED);

    expect(served(fake)).toBe(`${ROOT}/checkout`);
    expect(record(fake)).toMatchObject({ outcome: "rolled-back", stage: "restart" });
  });

  it("says the console may be down when the rollback does not answer either", async () => {
    const fake = fakePorts({ afterRestart: [undefined, undefined] });

    expect(await apply(fake)).toBe(EXIT.FAILED);

    expect(record(fake)).toMatchObject({ outcome: "rollback-failed", stage: "rollback" });
    expect(fake.alarms[0]!.summary).toMatch(/^CONSOLE MAY BE DOWN/);
  });

  it("keeps the old sha serving when the smoke check fails, and raises the alarm", async () => {
    const fake = fakePorts({ releaseSmoke: verdict("the new build on spare port 40123 answered /health with nothing") });

    expect(await apply(fake)).toBe(EXIT.FAILED);

    expect(served(fake)).toBe(PREV);
    expect(fake.calls.some((call) => call.startsWith("systemctl"))).toBe(false);
    expect(fake.alarms).toHaveLength(1);
    expect(fake.alarms[0]).toMatchObject({ asker: "titan-console", kind: "do", keys: ["console-update"] });
    expect(fake.alarms[0]!.context).toContain("aaaaaaa keeps serving");
    expect(record(fake)?.why).toBe("the new build on spare port 40123 answered /health with nothing");
    expect(removed(fake)).toEqual([RELEASE]);
  });

  // TP-3938: the installed updater's own smoke was broken, so the release carrying its fix never got past it.
  it("runs the new release's smoke check, not an in-process one", async () => {
    const fake = fakePorts({ smoke: "the old check bound a port the served console holds", releaseSmoke: verdict() });

    expect(await apply(fake)).toBe(EXIT.OK);

    expect(served(fake)).toBe(RELEASE);
    expect(fake.calls.some((call) => call.startsWith("smoke "))).toBe(false);
  });

  it("falls back to its own smoke check when the release answers with its usage", async () => {
    const usage = ran({ code: 64, stderr: "usage: titan-console                    serve the console\n" });
    const fake = fakePorts({ releaseSmoke: usage, smoke: "the new build on spare port 40123 did not serve its page at /" });

    expect(await apply(fake)).toBe(EXIT.FAILED);

    expect(fake.calls).toContain(`smoke ${RELEASE}`);
    expect(record(fake)).toMatchObject({ stage: "smoke", why: "the new build on spare port 40123 did not serve its page at /" });
  });

  // TP-3935: the smoke child's output was discarded, so the owner saw "answered with nothing" and not the EADDRINUSE.
  it("puts the end of a crashed smoke check's stderr in the record and the alarm", async () => {
    const noise = Array.from({ length: 30 }, (_, n) => `noise line ${n}`).join("\n");
    const crash = ran({ code: 1, stderr: `${noise}\nError: listen EADDRINUSE: address already in use 127.0.0.1:7501\n` });
    const fake = fakePorts({ releaseSmoke: crash });

    expect(await apply(fake)).toBe(EXIT.FAILED);

    const why = record(fake)?.why ?? "";
    expect(why).toMatch(/^the new build's smoke check exited 1 with no verdict; its stderr ended: /);
    expect(why).toContain("EADDRINUSE: address already in use 127.0.0.1:7501");
    expect(why).toContain("noise line 11");
    expect(why).not.toContain("noise line 10");
    expect(fake.alarms[0]!.context).toContain("EADDRINUSE");
    expect(served(fake)).toBe(PREV);
  });

  it("fails the smoke stage when the release's check runs past its time, even with a late verdict", async () => {
    const fake = fakePorts({ releaseSmoke: ran({ ...verdict(), timedOut: true, stderr: "still waiting on /health" }) });

    expect(await apply(fake)).toBe(EXIT.FAILED);

    expect(record(fake)).toMatchObject({ stage: "smoke", why: "the new build's smoke check did not finish in time; its stderr ended: still waiting on /health" });
    expect(fake.calls.some((call) => call.startsWith("smoke ") || call.startsWith("systemctl"))).toBe(false);
  });

  it("refuses a second run while another holds the lock", async () => {
    const fake = fakePorts({ liveHolder: 4242 });
    fake.files.set(lockPath(OPTIONS.stateDir), "4242");

    expect(await apply(fake)).toBe(EXIT.LOCKED);

    expect(fake.calls).toEqual([]);
    expect(fake.files.get(lockPath(OPTIONS.stateDir))).toBe("4242");
  });

  it("takes over a lock whose holder is gone and releases it after", async () => {
    const fake = fakePorts({ changed: [] });
    fake.files.set(lockPath(OPTIONS.stateDir), "4242");

    expect(await apply(fake)).toBe(EXIT.OK);

    expect(fake.files.has(lockPath(OPTIONS.stateDir))).toBe(false);
  });

  it("is a no-op when the target already serves", async () => {
    const fake = fakePorts({ serving: RELEASE });

    expect(await apply(fake)).toBe(EXIT.OK);

    expect(fake.calls.filter((call) => !call.startsWith("git rev-parse"))).toEqual([]);
  });

  it("refuses until the current symlink exists, and when the target was never built", async () => {
    const unlinked = fakePorts();
    unlinked.links.clear();
    const unbuilt = fakePorts();
    unbuilt.files.clear();

    expect(await apply(unlinked)).toBe(EXIT.CONFIG);
    expect(await apply(unbuilt)).toBe(EXIT.CONFIG);

    expect([...unlinked.calls, ...unbuilt.calls]).toEqual([]);
  });
});

describe("the bootstrap's failure report", () => {
  it("files the owner-queue alarm for a build failure the bootstrap recorded", async () => {
    const fake = fakePorts();
    fake.files.set(recordPath(OPTIONS.stateDir), JSON.stringify({ outcome: "failed", target: NEW, served: OLD, at: "2031-03-05T12:00:00.000Z", stage: "build", why: "pnpm build failed: vite: Could not resolve ./Footer.js" }));

    expect(await reportRecorded(fake.ports, OPTIONS.stateDir)).toBe(EXIT.OK);

    expect(fake.alarms.map((alarm) => alarm.depositId)).toEqual(["console-update-bbbbbbb-build"]);
    expect(fake.alarms[0]!.context).toContain("Could not resolve ./Footer.js");
  });

  it("files nothing when the last attempt did not fail", async () => {
    const fake = fakePorts();
    fake.files.set(recordPath(OPTIONS.stateDir), JSON.stringify({ outcome: "updated", target: NEW, served: OLD, at: "2031-03-05T12:00:00.000Z" }));

    expect(await reportRecorded(fake.ports, OPTIONS.stateDir)).toBe(EXIT.CONFIG);

    expect(fake.alarms).toEqual([]);
  });
});

describe("the console closure", () => {
  it("reads pnpm's package paths relative to the release", () => {
    expect(closureDirs(CLOSURE, RELEASE)).toEqual(["apps/console", "packages/daemon"]);
    expect(closureDirs("not json", ROOT)).toBeUndefined();
  });

  it("counts root build inputs and runtime files, not tests or docs, and keeps every path when the closure is unknown", () => {
    const changed = ["pnpm-lock.yaml", "tsconfig.base.json", "packages/daemon/src/x.ts", "packages/daemon/src/x.test.ts", "packages/pm/src/y.ts", "apps/console/CHANGELOG.md"];
    expect(touchedPaths(changed, ["apps/console", "packages/daemon"])).toEqual(["pnpm-lock.yaml", "tsconfig.base.json", "packages/daemon/src/x.ts"]);
    expect(touchedPaths(changed, undefined)).toEqual(changed);
  });
});
