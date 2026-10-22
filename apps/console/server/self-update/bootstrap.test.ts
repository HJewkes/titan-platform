import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap, EXIT, isMainModule, recordFile, type BootstrapOptions, type BootstrapPorts, type CommandResult } from "../../deploy/titan-console-bootstrap.mts";

const ROOT = "/srv/console";
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const RELEASE = `${ROOT}/releases/${NEW}`;
const OPTIONS: BootstrapOptions = { root: ROOT, stateDir: "/state" };
const BUILT = `${RELEASE}/apps/console/dist/build-info.json`;

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

interface Scenario {
  /** What HEAD in `current` resolves to; undefined when `current` is missing. */
  served?: string | undefined;
  build?: CommandResult;
  /** The exit code of the target's `--apply`, and whether it records an outcome first. */
  apply?: { code: number; records: boolean };
  liveHolder?: number;
}

interface Fake {
  ports: BootstrapPorts;
  files: Map<string, string>;
  calls: string[];
}

function fakePorts(scenario: Scenario = {}): Fake {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const served = "served" in scenario ? scenario.served : OLD;
  const apply = scenario.apply ?? { code: 0, records: true };
  const run = async (file: "git" | "pnpm", args: readonly string[], cwd: string): Promise<CommandResult> => {
    calls.push(`${file} ${args.join(" ")}`);
    if (args[0] === "rev-parse" && args[3] === "origin/main^{commit}") return ok(`${NEW}\n`);
    if (args[0] === "rev-parse") return served === undefined ? { code: 128, stdout: "", stderr: "not a git repository" } : ok(`${served}\n`);
    if (file === "pnpm" && args.includes("build")) {
      if (scenario.build !== undefined) return scenario.build;
      files.set(`${cwd}/apps/console/dist/build-info.json`, "{}");
    }
    return ok();
  };
  const handOff = async (script: string, args: readonly string[]): Promise<number> => {
    calls.push(`node ${script} ${args.join(" ")}`);
    if (args[1] !== "--apply") return 0;
    if (apply.records) files.set(recordFile(OPTIONS.stateDir), JSON.stringify({ outcome: "updated", target: NEW }));
    return apply.code;
  };
  const ports: BootstrapPorts = {
    pid: 100,
    run,
    handOff,
    readFile: (file) => files.get(file),
    writeFile: (file, text) => void files.set(file, text),
    createExclusive: (file, text) => (files.has(file) ? false : (files.set(file, text), true)),
    remove: (file) => void files.delete(file),
    isAlive: (pid) => pid === scenario.liveHolder,
    exists: (file) => [...files.keys()].some((key) => key === file || key.startsWith(`${file}/`)),
    mkdir: () => {},
    log: () => {},
    now: () => Date.parse("2031-03-05T12:00:00.000Z"),
  };
  return { ports, files, calls };
}

const handOffs = (fake: Fake) => fake.calls.filter((call) => call.startsWith("node "));
const record = (fake: Fake): unknown => JSON.parse(fake.files.get(recordFile(OPTIONS.stateDir)) ?? "null");

describe("the console update bootstrap", () => {
  // TP-4043: the installed updater was broken, so every build carrying its fix was judged by the broken code.
  it("builds origin/main into its own release and runs that release's updater, not the serving one's", async () => {
    const fake = fakePorts();

    expect(await bootstrap(fake.ports, OPTIONS)).toBe(EXIT.OK);

    expect(fake.calls).toContain(`git worktree add --detach ${RELEASE} ${NEW}`);
    expect(fake.calls).toContain("pnpm install --frozen-lockfile");
    expect(fake.calls).toContain("pnpm --filter titan-console... build");
    expect(handOffs(fake)).toEqual([`node ${RELEASE}/apps/console/dist/cli.js self-update --apply ${NEW}`]);
  });

  it("hands off without rebuilding a release that finished building", async () => {
    const fake = fakePorts();
    fake.files.set(BUILT, "{}");

    expect(await bootstrap(fake.ports, OPTIONS)).toBe(EXIT.OK);

    expect(fake.calls.some((call) => call.startsWith("pnpm") || call.includes("worktree"))).toBe(false);
    expect(handOffs(fake)).toHaveLength(1);
  });

  it("does nothing when origin/main already serves, or its sha was already judged", async () => {
    const serving = fakePorts({ served: NEW });
    const judged = fakePorts();
    judged.files.set(recordFile(OPTIONS.stateDir), JSON.stringify({ outcome: "failed", target: NEW, stage: "smoke" }));

    expect(await bootstrap(serving.ports, OPTIONS)).toBe(EXIT.OK);
    expect(await bootstrap(judged.ports, OPTIONS)).toBe(EXIT.OK);

    for (const fake of [serving, judged]) expect(fake.calls.filter((call) => !call.startsWith("git fetch") && !call.startsWith("git rev-parse"))).toEqual([]);
  });

  it("records a failed build, removes it and has the serving build file the alarm", async () => {
    const fake = fakePorts({ build: { code: 1, stdout: "", stderr: "vite: Could not resolve ./Footer.js" } });

    expect(await bootstrap(fake.ports, OPTIONS)).toBe(EXIT.FAILED);

    expect(record(fake)).toMatchObject({ outcome: "failed", target: NEW, served: OLD, stage: "build", why: "pnpm --filter titan-console... build failed: vite: Could not resolve ./Footer.js" });
    expect(fake.files.get("/state/self-update-build.log")).toContain("Could not resolve ./Footer.js");
    expect(fake.calls).toContain(`git worktree remove --force ${RELEASE}`);
    expect(handOffs(fake)).toEqual([`node ${ROOT}/current/apps/console/dist/cli.js self-update --report`]);
  });

  it("records and reports a hand-off that exits without recording an outcome", async () => {
    const fake = fakePorts({ apply: { code: 1, records: false } });

    expect(await bootstrap(fake.ports, OPTIONS)).toBe(EXIT.FAILED);

    expect(record(fake)).toMatchObject({ outcome: "failed", target: NEW, stage: "handoff", why: `${NEW}'s updater exited 1 without recording an outcome` });
    expect(handOffs(fake).at(-1)).toBe(`node ${ROOT}/current/apps/console/dist/cli.js self-update --report`);
  });

  it("leaves a failure the target's updater recorded and alarmed to it", async () => {
    const fake = fakePorts({ apply: { code: 1, records: true } });

    expect(await bootstrap(fake.ports, OPTIONS)).toBe(1);

    expect(handOffs(fake)).toHaveLength(1);
  });

  it("refuses while another run holds its lock, and stops on a missing current symlink", async () => {
    const locked = fakePorts({ liveHolder: 4242 });
    locked.files.set("/state/self-update-bootstrap.lock", "4242");
    const unlinked = fakePorts({ served: undefined });

    expect(await bootstrap(locked.ports, OPTIONS)).toBe(EXIT.LOCKED);
    expect(await bootstrap(unlinked.ports, OPTIONS)).toBe(EXIT.CONFIG);

    expect(locked.calls).toEqual([]);
    expect(handOffs(unlinked)).toEqual([]);
    expect(unlinked.files.has("/state/self-update-bootstrap.lock")).toBe(false);
  });
});

describe("the bootstrap's entry guard", () => {
  let scratch: string | undefined;
  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it("runs when launched through the current symlink, as the legacy bare self-update does", () => {
    scratch = mkdtempSync(path.join(tmpdir(), "bootstrap-guard-"));
    const deploy = path.join(scratch, "releases", NEW, "apps/console/deploy");
    mkdirSync(deploy, { recursive: true });
    const script = path.join(deploy, "titan-console-bootstrap.mts");
    writeFileSync(script, "");
    symlinkSync(path.join(scratch, "releases", NEW), path.join(scratch, "current"));

    const viaCurrent = path.join(scratch, "current/apps/console/deploy/titan-console-bootstrap.mts");

    expect(isMainModule(pathToFileURL(script).href, viaCurrent)).toBe(true);
    expect(isMainModule(pathToFileURL(script).href, script)).toBe(true);
  });

  it("does not run when imported by another entry, or with no script argument", () => {
    const resolve = (file: string): string => file.replace("/current/", `/releases/${NEW}/`);
    const url = pathToFileURL(`${RELEASE}/apps/console/deploy/titan-console-bootstrap.mts`).href;

    expect(isMainModule(url, "/srv/tester/node_modules/vitest/vitest.mjs", resolve)).toBe(false);
    expect(isMainModule(url, undefined, resolve)).toBe(false);
  });
});
