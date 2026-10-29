import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDITABLE_FIELDS, type EditableField } from "@titan-design/coordinator";
import { CONFIG_PATH, formatResultLine } from "@titan-design/fix-proof";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type PrFile } from "@titan-design/github";
import { silentLogger } from "@titan-design/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { configPath } from "./config.js";
import { LIVE_FIELDS, configRef } from "./config-ref.js";
import { openFactoryHost, type FactoryHost, type FactoryRoutes } from "./host.js";
import { startFactoryServer, type FactoryServer } from "./serve.js";
import { FIX_PROOF_CHECK } from "./shepherd/fix-proof.js";
import { OWNER_GATE_POLICY } from "./shepherd/policy.js";
import { shepherdStoreRef } from "./shepherd/store.js";
import { SpawnDeferred, spawnGate } from "./shepherd/spawn-gate.js";
import { configuredRoutes, configuredSpawnLimits } from "./workflows.js";
import { liveSpawnLimits } from "./workflows-live.js";

const REPO = "octo/demo";
const H = fakeSha("config-ref-head");
const BASE = fakeSha("config-ref-base");
const MERGE_BASE = fakeSha("config-ref-merge-base");
const FIX_PROOF_JOB = 77;
const TESTS_ONLY: PrFile[] = [{ path: "packages/x/src/a.test.ts", status: "modified" }];

const dirs: string[] = [];
const hosts: FactoryHost[] = [];
const servers: FactoryServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function configHome(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "factory-config-ref-"));
  dirs.push(home);
  mkdirSync(join(home, "titan-factory"));
  return { XDG_CONFIG_HOME: home, XDG_STATE_HOME: join(home, "state") };
}

const writeConfig = (env: NodeJS.ProcessEnv, config: object) => writeFileSync(configPath(env), JSON.stringify(config));
const noRepro = (mode: "off" | "on") => ({ shepherd: { gateReset: { noReproProceed: mode } } });

/** Factory rows marked live whose pattern has no reader in `LIVE_FIELDS`. */
const rowsWithoutGetter = (rows: readonly EditableField[]) => rows.filter((row) => row.surface === "factory" && row.reload === "live" && !(row.pattern in LIVE_FIELDS)).map((row) => row.pattern);

describe("EDITABLE_FIELDS live factory rows", () => {
  it("each have a registered getter", () => {
    expect(rowsWithoutGetter(EDITABLE_FIELDS)).toEqual([]);
  });

  it("would fail for a live row with no getter", () => {
    const unwired: EditableField = { surface: "factory", pattern: "shepherd.review.panel", schema: z.string(), reload: "live" };

    expect(rowsWithoutGetter([...EDITABLE_FIELDS, unwired])).toEqual(["shepherd.review.panel"]);
  });

  it("register no getter for a row that is not live", () => {
    const live = new Set(EDITABLE_FIELDS.filter((row) => row.surface === "factory" && row.reload === "live").map((row) => row.pattern));

    expect(Object.keys(LIVE_FIELDS).filter((path) => !live.has(path))).toEqual([]);
  });
});

describe("configRef", () => {
  it("serves the reloaded file and stamps it with the new bytes' sha", () => {
    const env = configHome();
    writeConfig(env, noRepro("off"));
    const ref = configRef(configPath(env));
    const before = ref.stamp().sha;

    writeConfig(env, noRepro("on"));
    const after = ref.reload().sha;

    expect(ref.get().shepherd?.gateReset?.noReproProceed).toBe("on");
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
  });

  it("keeps the loaded config when the reloaded file is invalid", () => {
    const env = configHome();
    writeConfig(env, noRepro("off"));
    const ref = configRef(configPath(env), Date.now, { warn: () => undefined });
    const stamp = ref.stamp();

    writeConfig(env, { shepherd: { gateReset: { noReproProceed: "maybe" } } });

    expect(() => ref.reload()).toThrow(/noReproProceed/);
    expect(ref.get().shepherd?.gateReset?.noReproProceed).toBe("off");
    expect(ref.stamp()).toEqual(stamp);
  });

  it("stamps an absent file with no sha", () => {
    expect(configRef(configPath(configHome())).stamp().sha).toBeNull();
  });
});

const CONFIG_FILE = "/config/titan-factory/config.json";

/** An in-memory config file: each write bumps the probe, as a save moves mtime; `reads` counts the parses it fed. */
function fakeConfigFile(initial: object) {
  let text = JSON.stringify(initial);
  let version = 0;
  const file = {
    reads: 0,
    write(next: object | string) {
      text = typeof next === "string" ? next : JSON.stringify(next);
      version += 1;
    },
    probe: () => `v${version}`,
    read() {
      file.reads += 1;
      return Buffer.from(text);
    },
  };
  return file;
}

const visualKey = { shepherd: { visualThreshold: { "octo/ui": { mode: "shadow" as const, snapshotPaths: [], apiPaths: [], tokenPaths: [], harnessPaths: [] } } } };

describe("configRef without a reload", () => {
  it("shows a key added to the file after load on the next read", () => {
    const file = fakeConfigFile({});
    const ref = configRef(CONFIG_FILE, () => 0, { file, warn: () => undefined });
    const before = ref.get().shepherd?.visualThreshold;

    file.write(visualKey);

    expect(before).toBeUndefined();
    expect(ref.get().shepherd?.visualThreshold?.["octo/ui"]?.mode).toBe("shadow");
    expect(ref.stamp().sha).toBe(createHash("sha256").update(JSON.stringify(visualKey)).digest("hex"));
  });

  it("does not re-parse while the file's probe is unchanged", () => {
    const file = fakeConfigFile(noRepro("off"));
    const ref = configRef(CONFIG_FILE, () => 0, { file, warn: () => undefined });

    ref.get();
    ref.stamp();
    ref.get();

    expect(file.reads).toBe(1);
  });

  it("keeps the previous config on an invalid edit and warns once", () => {
    const file = fakeConfigFile(noRepro("off"));
    const warnings: string[] = [];
    const ref = configRef(CONFIG_FILE, () => 0, { file, warn: (line) => warnings.push(line) });
    const stamp = ref.stamp();

    file.write({ shepherd: { gateReset: { noReproProceed: "maybe" } } });
    ref.get();

    expect(ref.get().shepherd?.gateReset?.noReproProceed).toBe("off");
    expect(ref.stamp()).toEqual(stamp);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/noReproProceed/);
  });

  it("loads a fixed edit after an invalid one", () => {
    const file = fakeConfigFile(noRepro("off"));
    const ref = configRef(CONFIG_FILE, () => 0, { file, warn: () => undefined });

    file.write("{ not json");
    ref.get();
    file.write(noRepro("on"));

    expect(ref.get().shepherd?.gateReset?.noReproProceed).toBe("on");
  });
});

/** A test-only PR whose fix-proof is vacuous and whose diff is tests alone: only `noReproProceed: on` lets it proceed. */
function vacuousTestOnly(): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H, mergeSha: fakeSha("config-ref-merge") });
  fake.setRuns(H, [successRun("validate", 1), successRun("dag-check", 2), { ...successRun(FIX_PROOF_CHECK, FIX_PROOF_JOB), headSha: H, pullRequests: [{ number: 1, baseRef: "main" }] }]);
  const counts = { reproduces: 0, "passes-on-base": 0, "new-api": 0, "fails-on-head": 0, "not-run": 0 };
  const line = formatResultLine({ head: H, mergeBase: BASE, base: "main", verdict: "vacuous", counts, notCollected: [], deletedTests: [], configEdited: false, tests: [], truncated: false });
  fake.jobLogs.set(FIX_PROOF_JOB, ["Run pnpm fix-proof", line, "Post job cleanup."].map((text) => `2026-10-11T12:00:00.0000000Z ${text}`).join("\n"));
  fake.prFiles.set(1, TESTS_ONLY);
  fake.compares.set(`main...${H}`, { mergeBaseSha: MERGE_BASE, files: [] });
  const globs = JSON.stringify({ tests: ["packages/*/src/**/*.test.ts"], carry: [] });
  for (const ref of [MERGE_BASE, "main"]) fake.files.set(`${ref}:${CONFIG_PATH}`, { content: globs, blobSha: fakeSha(`${ref}:config`) });
  for (const ref of [H, MERGE_BASE]) fake.files.set(`${ref}:${TESTS_ONLY[0]!.path}`, { content: "blob", blobSha: fakeSha(`${ref}:blob`) });
  return fake;
}

async function readFixProofStep(routes: FactoryRoutes, runId: string): Promise<unknown> {
  const route = routes.find((candidate) => candidate.match === "sh-fix-proof");
  if (!route) throw new Error("no sh-fix-proof route");
  const prompt = JSON.stringify({ repo: REPO, head: H, runId });
  const outcome = await route.runner.run({ runId, workflowName: "shepherd-pr", stepId: `sh-fix-proof:${H}`, iteration: 0, prompt, signal: new AbortController().signal, attempt: 1, requestKey: "k" });
  const { output } = z.object({ ok: z.literal(true), output: z.string() }).parse(outcome);
  return z.object({ result: z.unknown() }).parse(JSON.parse(output)).result;
}

describe("configuredRoutes after a config reload", () => {
  it("lets readFixProof see noReproProceed on with no restart", async () => {
    const env = configHome();
    writeConfig(env, noRepro("off"));
    const store = shepherdStoreRef();
    let clock = 0;
    const routes = configuredRoutes(env, { port: githubPort(vacuousTestOnly().wire), store, now: () => clock, sleep: async (ms) => void (clock += ms) });
    hosts.push(openFactoryHost({ dbPath: ":memory:", workflows: [], routes }));
    store.get().register({ repo: REPO, pr: 1, runId: "run-1", task: "demo: pin the parser", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind: "test-only" });
    const before = await readFixProofStep(routes, "run-1");

    writeConfig(env, noRepro("on"));
    routes.config?.reload();

    expect(before).toMatchObject({ kind: "result", verdict: "vacuous" });
    expect(before).not.toHaveProperty("testOnlyProceed");
    expect(await readFixProofStep(routes, "run-1")).toMatchObject({ kind: "result", verdict: "vacuous", testOnlyProceed: true });
  });

});

describe("liveSpawnLimits", () => {
  it("reads the live rows afresh, the pace windows included, and keeps restart-class keys at their startup value", () => {
    const env = configHome();
    const startup = { spawnGate: { load5: 10, buildLoad5: 12, windowMs: 1_000, headroomIntervalMs: 500, reviewLoad: 3 }, agentChatBin: "/opt/agent-chat", review: { profile: "example-reviewer", maxConcurrent: 2 } };
    writeConfig(env, { shepherd: startup });
    const config = configRef(configPath(env));
    const limits = liveSpawnLimits(configuredSpawnLimits(startup), config);

    writeConfig(env, { shepherd: { ...startup, spawnGate: { load5: 30, windowMs: 0, headroomIntervalMs: 0, reviewLoad: 9 }, review: { ...startup.review, maxConcurrent: 5 } } });
    config.reload();

    expect(limits()).toEqual({ load5: 30, maxConcurrentReviews: 5, windowMs: 0, headroomIntervalMs: 0, reviewLoad: 3 });
  });

  it("lets the spawn gate admit at a load the reloaded limit allows", () => {
    let load5 = 10;
    const gate = spawnGate({ limits: () => ({ load5, buildLoad5: 100 }), read: () => ({ load5: 15, pressureLevel: 1, freeMemoryPct: 50 }), log: () => undefined });

    expect(() => gate.admit("impl-a")).toThrow(SpawnDeferred);
    load5 = 20;
    expect(() => gate.admit("impl-a")).not.toThrow();
  });
});

async function healthConfig(server: FactoryServer): Promise<{ sha: string | null; loadedAt: string }> {
  const health: unknown = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json();
  return z.object({ config: z.object({ sha: z.string().nullable(), loadedAt: z.string() }) }).parse(health).config;
}

describe("/health config", () => {
  it("names the sha of the loaded file and moves with a reload", async () => {
    const env = configHome();
    writeConfig(env, noRepro("off"));
    const config = configRef(configPath(env));
    const stateDir = join(env.XDG_STATE_HOME!, "titan-factory");
    const server = await startFactoryServer({ dbPath: join(stateDir, "factory.sqlite3"), workflows: [], routes: Object.assign([], { config }), port: 0, logger: silentLogger, github: { status: () => "ok", refresh: async () => undefined } });
    servers.push(server);
    const before = await healthConfig(server);

    writeConfig(env, noRepro("on"));
    config.reload();

    expect((await healthConfig(server)).sha).toBe(config.stamp().sha);
    expect(before.sha).not.toBe(config.stamp().sha);
  });
});
