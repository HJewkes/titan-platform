import { tmpdir } from "node:os";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type GitHubPort } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { freezeStoreRef } from "./freeze.js";
import type { MainRedWiring } from "./main-red.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { readMainCi, SH_MAIN_CI_TIMEOUT_MS, type MainCiInput } from "./post-merge.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef } from "./store.js";

type Run = ReturnType<typeof successRun>;

const RED = fakeSha("episode-red");
const FIX = fakeSha("fix-merge");
/** The fix merge's run settles 90 minutes after the red is first read, past the red's 60-minute wait. */
const SETTLES_AT = 90 * 60_000;
const running = (name: string, id: number): Run => ({ ...successRun(name, id), status: "in_progress", conclusion: null });
const requiredRed = (id: number): Run[] => [successRun("validate", id, undefined, "failure"), successRun("dag-check", id + 1)];
const requiredGreen = (id: number): Run[] => [successRun("validate", id), successRun("dag-check", id + 1)];

type Outcome = "green" | "red" | "never";

/** Episode 29: main is red at `red`, and the later merge FIX that descends from it is the tip with its run in progress. */
function fixMergedOver(fake: FakeGitHub, red: string): void {
  fake.setRuns(red, requiredRed(1));
  fake.refs.set("main", FIX);
  fake.history = [
    { sha: FIX, message: "fix (#2)", committedAt: "2026-10-25T11:00:00Z" },
    { sha: red, message: "red (#1)", committedAt: "2026-10-25T10:20:00Z" },
  ];
  fake.compares.set(`${red}...${FIX}`, { mergeBaseSha: red, files: [] });
  fake.setRuns(FIX, [running("validate", 90), running("dag-check", 91)]);
}

/** FIX's run settles to `outcome` once the clock passes SETTLES_AT. */
function settling(port: GitHubPort, fake: FakeGitHub, clock: () => number, outcome: Outcome): GitHubPort {
  const settle = () => {
    if (outcome === "never" || clock() < SETTLES_AT) return;
    fake.setRuns(FIX, outcome === "green" ? requiredGreen(92) : requiredRed(92));
  };
  return { ...port, checkRuns: async (repo, sha) => (settle(), port.checkRuns(repo, sha)) };
}

async function readEpisode(outcome: Outcome, unreadableTip = false) {
  const fake = fakeGitHub();
  fixMergedOver(fake, RED);
  let clock = 0;
  const base = githubPort(fake.wire);
  const read = unreadableTip ? { ...base, checkRuns: async (repo: string, sha: string) => (sha === FIX ? Promise.reject(new Error("checks unreadable")) : base.checkRuns(repo, sha)) } : base;
  const timing = { now: () => clock, sleep: async (ms: number) => void (clock += ms), pollMs: 30_000, timeoutMs: SH_MAIN_CI_TIMEOUT_MS };
  const input: MainCiInput = { repo: REPO, pr: 1, baseRef: "main", mergeSha: RED, after: [] };
  const result = await readMainCi(settling(read, fake, () => clock, outcome), input, timing, new AbortController().signal);
  return { result, clock };
}

describe("readMainCi on a red whose fix merged after it with its run still in progress", () => {
  it("holds the red for the fix's run and reads its green as clearing it", async () => {
    const { result } = await readEpisode("green");

    expect(result).toMatchObject({ verdict: "green", acknowledgedSha: FIX, awaitedSha: FIX });
  });

  it("lets the red stand on the next poll once the awaited run goes red", async () => {
    const { result, clock } = await readEpisode("red");

    expect(result).toMatchObject({ verdict: "red", detail: "failed: validate", awaitedSha: FIX });
    expect(clock).toBeLessThan(SETTLES_AT + 5 * 60_000);
  });

  it("lets the red stand after the re-checks when the awaited run never settles", async () => {
    const { result } = await readEpisode("never");

    expect(result).toMatchObject({ verdict: "red", awaitedSha: FIX });
  });

  it("lets the red stand at its wait, as before, when the tip's runs cannot be read", async () => {
    const { result, clock } = await readEpisode("green", true);

    expect(result).toMatchObject({ verdict: "red", detail: "failed: validate" });
    expect(result.awaitedSha).toBeUndefined();
    expect(clock).toBeLessThan(SETTLES_AT);
  });
});

describe("readMainCi on a red whose descendant tip has no check runs yet (serve restart, TP-4653)", () => {
  it("does not stand the red before the descendant's run, queued after a gap with none, concludes green", async () => {
    const fake = fakeGitHub();
    fixMergedOver(fake, RED);
    fake.setRuns(FIX, []);
    let clock = 0;
    const base = githubPort(fake.wire);
    const queuedAt = SETTLES_AT - 5 * 60_000;
    const port: GitHubPort = {
      ...base,
      checkRuns: async (repo, sha) => {
        if (clock >= SETTLES_AT) fake.setRuns(FIX, requiredGreen(92));
        else if (clock >= queuedAt) fake.setRuns(FIX, [running("validate", 90), running("dag-check", 91)]);
        return base.checkRuns(repo, sha);
      },
    };
    const timing = { now: () => clock, sleep: async (ms: number) => void (clock += ms), pollMs: 30_000, timeoutMs: SH_MAIN_CI_TIMEOUT_MS };
    const input: MainCiInput = { repo: REPO, pr: 1, baseRef: "main", mergeSha: RED, after: [] };

    const result = await readMainCi(port, input, timing, new AbortController().signal);

    expect(result).toMatchObject({ verdict: "green", acknowledgedSha: FIX, awaitedSha: FIX });
    expect(clock).toBeGreaterThanOrEqual(SETTLES_AT);
  });
});

const FIXER_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, fixer: true, seat: "demo-seat" };

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A registered Shepherd run with active-work and agent-chat wired; main is laid out the first time the merge sha is read. */
function episodeWorld(outcome: Outcome) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, requiredGreen(1));
  let clock = 0;
  let laid = false;
  const base = githubPort(fake.wire);
  const layOut = (sha: string) => {
    if (laid || sha !== fake.pr(1).mergeSha) return;
    laid = true;
    fixMergedOver(fake, sha);
  };
  const port = settling({ ...base, checkRuns: async (repo, sha) => (layOut(sha), base.checkRuns(repo, sha)) }, fake, () => clock, outcome);
  const added: string[] = [];
  const spawned: string[] = [];
  const mainRed: Omit<MainRedWiring, "freezes"> = {
    tasks: { findByTag: async () => undefined, add: async (_initiative, fields) => `FX-${added.push(fields.title)}` },
    fixers: { roster: async () => spawned.map((name) => ({ name })), spawn: async (name) => void spawned.push(name) },
    checkoutFor: () => tmpdir(),
  };
  const freeze = freezeStoreRef(() => clock);
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port, store, freeze, now: () => clock, sleep: async (ms, signal) => (signal.throwIfAborted(), void (clock += ms)), mainRed });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, store, added, spawned, freezes: () => freeze.get() };
}

async function mergedAndWaited(w: ReturnType<typeof episodeWorld>): Promise<string[]> {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(FIXER_POLICY) });
  w.store.get().register({ repo: REPO, pr: 1, runId, task: "demo/TP-1", implementer: "impl-a", policy: FIXER_POLICY });
  await gateOpened(w.host, gateId(runId, "approve-merge"));
  w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
  await w.host.runtime.wait(runId);
  return Object.values(w.host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
}

describe("shepherd-pr on the episode 29 shape: a red, then a fix merged over it with its run in progress", () => {
  it("freezes nothing, files no task and spawns no fixer when the fix's run goes green", async () => {
    const w = episodeWorld("green");

    const steps = await mergedAndWaited(w);

    expect(steps).not.toContain("sh-freeze");
    expect(w.freezes().isFrozen(REPO)).toBe(false);
    expect(w.added).toEqual([]);
    expect(w.spawned).toEqual([]);
  });

  it("opens the normal episode when the fix's run goes red", async () => {
    const w = episodeWorld("red");

    const steps = await mergedAndWaited(w);

    expect(steps).toContain("sh-freeze");
    expect(w.added).toHaveLength(1);
    expect(w.spawned).toHaveLength(1);
  });
});
