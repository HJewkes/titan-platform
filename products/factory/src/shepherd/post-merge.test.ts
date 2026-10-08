import { tmpdir } from "node:os";
import { GITHUB_ACTIONS_APP_ID, fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { CleanupPorts } from "./cleanup.js";
import { freezeStoreRef } from "./freeze.js";
import type { MainRedWiring } from "./main-red.js";
import { readMainCi, SH_MAIN_CI_TIMEOUT_MS, type Classified, type MainCiInput } from "./post-merge.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import type { MAIN_CI_ROUTES } from "./route-table.js";
import { shepherdStoreRef } from "./store.js";
import { expectBrief } from "../test-support/brief.js";
import { OWNER } from "../test-support/resolver.js";
import { LEAKY_MESSAGE, expectNoLeak } from "../test-support/leak.js";

const MERGE = fakeSha("merge");
const OTHER_APP = 999;
const input: MainCiInput = { repo: REPO, mergeSha: MERGE, after: [] };

function clockedTiming() {
  let clock = 0;
  return { now: () => clock, sleep: async (ms: number) => void (clock += ms), pollMs: 30_000, timeoutMs: SH_MAIN_CI_TIMEOUT_MS };
}

const read = (fake: FakeGitHub, timing = clockedTiming(), given: MainCiInput = input) => readMainCi(githubPort(fake.wire), given, timing, new AbortController().signal);

describe("readMainCi", () => {
  it("reads the merge sha, not the PR head sha", async () => {
    const fake = fakeGitHub();
    fake.setRuns(H1, [successRun("validate", 1)]);
    fake.setRuns(MERGE, [successRun("validate", 2, undefined, "failure")]);

    const result = await read(fake);

    expect(result).toMatchObject({ verdict: "red", mergeSha: MERGE });
  });

  it("does not count a run from an app that is not allowed", async () => {
    const fake = fakeGitHub();
    fake.setRuns(MERGE, [successRun("validate", 1, undefined, "success", OTHER_APP)]);

    const result = await read(fake);

    expect(result.verdict).toBe("none");
  });

  it("ignores a red run from a non-allowed app beside a green allowed run", async () => {
    const fake = fakeGitHub();
    fake.setRuns(MERGE, [successRun("validate", 1), successRun("external", 2, undefined, "failure", OTHER_APP)]);

    expect((await read(fake)).verdict).toBe("green");
  });

  it("answers none, not green, when the deadline passes with no run", async () => {
    const timing = clockedTiming();

    const result = await read(fakeGitHub(), timing);

    expect(result.verdict).toBe("none");
    expect(timing.now()).toBeGreaterThanOrEqual(SH_MAIN_CI_TIMEOUT_MS);
  });

  it("answers none when a run never finishes before the deadline", async () => {
    const fake = fakeGitHub();
    fake.setRuns(MERGE, [{ ...successRun("validate", 1), status: "in_progress", conclusion: null }]);

    expect((await read(fake)).verdict).toBe("none");
  });

  it("keeps an older red run visible beside a newer green run of the same name", async () => {
    const fake = fakeGitHub();
    fake.setRuns(MERGE, [successRun("validate", 1, "2026-01-01T00:00:00Z", "failure"), successRun("validate", 2, "2026-01-01T01:00:00Z")]);

    expect((await read(fake)).verdict).toBe("red");
  });

  it("answers none when the read fails until the deadline", async () => {
    const fake = fakeGitHub();
    fake.wire.listCheckRuns = async () => {
      throw new Error("boom");
    };

    expect((await read(fake)).verdict).toBe("none");
  });

  it("names only the error class in the detail when the read fails until the deadline", async () => {
    const fake = fakeGitHub();
    fake.wire.listCheckRuns = async () => {
      throw new Error(LEAKY_MESSAGE);
    };

    const result = await read(fake);

    expect(result.detail).toMatch(/: Error$/);
    expectNoLeak(result);
  });

  describe("a run cancelled by concurrency", () => {
    const NEWER = fakeSha("newer-main-push");
    const cancelled = successRun("validate", 1, undefined, "cancelled");

    function superseded(newerConclusion: string): FakeGitHub {
      const fake = fakeGitHub();
      fake.rules = { contexts: [], strict: false };
      fake.addPr({ headSha: H1, baseRef: "main" });
      fake.setRuns(MERGE, [cancelled]);
      fake.refs.set("main", NEWER);
      fake.compares.set(`${MERGE}...${NEWER}`, { mergeBaseSha: MERGE, files: [] });
      fake.setRuns(NEWER, [successRun("validate", 2, undefined, newerConclusion)]);
      return fake;
    }

    it("waits for the newer main push's run when a newer push superseded it, and answers green on that run", async () => {
      const result = await read(superseded("success"), clockedTiming(), { ...input, pr: 1 });

      expect(result).toMatchObject({ verdict: "green", mergeSha: MERGE, readSha: NEWER });
    });

    it("answers red when the newer push's run fails", async () => {
      expect(await read(superseded("failure"), clockedTiming(), { ...input, pr: 1 })).toMatchObject({ verdict: "red", readSha: NEWER });
    });

    it("waits out the deadline, never red, when main has not moved past the merge sha", async () => {
      const fake = superseded("success");
      fake.refs.set("main", MERGE);

      expect(await read(fake, clockedTiming(), { ...input, pr: 1 })).toMatchObject({ verdict: "none", detail: expect.stringContaining("cancelled: validate") });
    });

    it("waits out the deadline when main's tip does not contain the merge sha", async () => {
      const fake = superseded("success");
      fake.compares.set(`${MERGE}...${NEWER}`, { mergeBaseSha: fakeSha("elsewhere"), files: [] });

      expect((await read(fake, clockedTiming(), { ...input, pr: 1 })).verdict).toBe("none");
    });

    it("waits out the deadline when the step input names no PR to read the base branch from", async () => {
      expect((await read(superseded("success"))).verdict).toBe("none");
    });
  });

  describe("a run still queued at the wait limit", () => {
    const TIP = fakeSha("descendant-tip");
    const queued = { ...successRun("validate", 1), status: "queued", conclusion: null };

    function backlog(tipRuns: ReturnType<typeof successRun>[], mergeBase = MERGE): FakeGitHub {
      const fake = fakeGitHub();
      fake.rules = { contexts: [], strict: false };
      fake.addPr({ headSha: H1, baseRef: "main" });
      fake.setRuns(MERGE, [queued]);
      fake.refs.set("main", TIP);
      fake.compares.set(`${MERGE}...${TIP}`, { mergeBaseSha: mergeBase, files: [] });
      fake.setRuns(TIP, tipRuns);
      return fake;
    }

    it("records the green verdict of the newest completed run on a descendant that contains the merge sha", async () => {
      const result = await read(backlog([successRun("validate", 2)]), clockedTiming(), { ...input, pr: 1 });

      expect(result).toMatchObject({ verdict: "green", readSha: TIP });
    });

    it("answers red from a red descendant run, not none", async () => {
      expect(await read(backlog([successRun("validate", 2, undefined, "failure")]), clockedTiming(), { ...input, pr: 1 })).toMatchObject({ verdict: "red", readSha: TIP });
    });

    it("never reads a descendant that does not contain the merge sha", async () => {
      const fake = backlog([successRun("validate", 2)], fakeSha("elsewhere"));

      expect((await read(fake, clockedTiming(), { ...input, pr: 1 })).verdict).toBe("none");
    });

    it("waits another window and answers green when the queued run finishes in it", async () => {
      const fake = backlog([]);
      let clock = 0;
      const timing = { ...clockedTiming(), now: () => clock, sleep: async (ms: number) => void ((clock += ms), clock > SH_MAIN_CI_TIMEOUT_MS + 60_000 && fake.setRuns(MERGE, [successRun("validate", 1)])) };

      expect(await read(fake, timing, { ...input, pr: 1 })).toMatchObject({ verdict: "green" });
    });

    it("answers none naming the missing completed run once the re-checks are spent", async () => {
      const timing = clockedTiming();

      const result = await read(backlog([]), timing, { ...input, pr: 1 });

      expect(result).toMatchObject({ verdict: "none", detail: expect.stringContaining(`no completed main run containing ${MERGE} within 240 min`) });
      expect(timing.now()).toBeGreaterThanOrEqual(4 * SH_MAIN_CI_TIMEOUT_MS);
    });
  });

  describe("a red, cancelled or missing merge sha with a later main commit containing it", () => {
    const TIP = fakeSha("green-descendant");
    const failing = (name: string) => successRun(name, 3, undefined, "failure");
    const requiredGreen = [successRun("validate", 4), successRun("dag-check", 5)];

    /** Main sits at the merge sha until `movesAtMs`, then at TIP, which contains the merge and carries `tipRuns`. */
    function laterMain(mergeRuns: ReturnType<typeof successRun>[], tipRuns: ReturnType<typeof successRun>[], movesAtMs = 10 * 60_000, mergeBase = MERGE) {
      const fake = fakeGitHub();
      fake.addPr({ headSha: H1, baseRef: "main" });
      fake.setRuns(MERGE, mergeRuns);
      fake.refs.set("main", MERGE);
      fake.compares.set(`${MERGE}...${TIP}`, { mergeBaseSha: mergeBase, files: [] });
      fake.setRuns(TIP, tipRuns);
      const timing = clockedTiming();
      const sleep = timing.sleep;
      timing.sleep = async (ms: number) => {
        await sleep(ms);
        if (timing.now() >= movesAtMs) fake.refs.set("main", TIP);
      };
      return { fake, timing };
    }

    const readLater = ({ fake, timing }: ReturnType<typeof laterMain>) => read(fake, timing, { ...input, pr: 1 });

    it("acknowledges a red merge sha on a later main commit green on every required context, recording that sha", async () => {
      const world = laterMain([failing("validate")], requiredGreen);

      const result = await readLater(world);

      expect(result).toMatchObject({ verdict: "green", mergeSha: MERGE, readSha: TIP, acknowledgedSha: TIP, detail: expect.stringContaining("failed: validate") });
      expect(world.timing.now()).toBeLessThan(SH_MAIN_CI_TIMEOUT_MS);
    });

    it("reads a cancelled merge sha's later commit green on every required context, warning of the check that failed outside them", async () => {
      const world = laterMain([successRun("validate", 3, undefined, "cancelled")], [...requiredGreen, failing("lint")]);

      expect(await readLater(world)).toMatchObject({ verdict: "green", readSha: TIP, warning: "not required, so not blocking: lint" });
    });

    it("acknowledges a merge sha with no run yet on a later commit green on every required context", async () => {
      expect(await readLater(laterMain([], [...requiredGreen, failing("lint")]))).toMatchObject({ verdict: "green", acknowledgedSha: TIP });
    });

    it("is green on the merge sha itself, with a warning, when it is red only on a check that is not required", async () => {
      const world = laterMain([...requiredGreen, failing("lint")], [], Number.POSITIVE_INFINITY);

      expect(await readLater(world)).toMatchObject({ verdict: "green", warning: "not required, so not blocking: lint" });
    });

    it("answers red after a fresh full wait when the later commit stays red", async () => {
      const world = laterMain([failing("validate")], [failing("validate"), successRun("dag-check", 5)]);

      const result = await readLater(world);

      expect(result).toMatchObject({ verdict: "red", detail: "failed: validate" });
      expect(result.acknowledgedSha).toBeUndefined();
      expect(world.timing.now()).toBeGreaterThanOrEqual(SH_MAIN_CI_TIMEOUT_MS);
    });

    it("never acknowledges a later commit missing a required context", async () => {
      expect(await readLater(laterMain([failing("validate")], [successRun("validate", 4)]))).toMatchObject({ verdict: "red" });
    });

    it("never acknowledges a green commit that does not contain the merge sha", async () => {
      expect(await readLater(laterMain([failing("validate")], requiredGreen, 0, fakeSha("elsewhere")))).toMatchObject({ verdict: "red" });
    });

    it("never acknowledges when the required contexts cannot be read", async () => {
      const world = laterMain([failing("validate")], requiredGreen);
      world.fake.wire.getBranchRules = async () => {
        throw new Error("boom");
      };

      expect(await readLater(world)).toMatchObject({ verdict: "red" });
    });

    it("never acknowledges when the repo requires no context", async () => {
      const world = laterMain([failing("validate")], requiredGreen);
      world.fake.rules.contexts = [];

      expect(await readLater(world)).toMatchObject({ verdict: "red" });
    });
  });

  describe("a run cancelled and re-run at the same sha", () => {
    const CANCELLED_AT = "2026-10-05T00:29:38Z";
    const RERUN_AT = "2026-10-05T00:31:31Z";

    it("answers green when the later run of each cancelled check passed, whatever the array order", async () => {
      const fake = fakeGitHub();
      fake.setRuns(MERGE, [successRun("validate", 7, RERUN_AT), successRun("build", 8, RERUN_AT), successRun("validate", 3, CANCELLED_AT, "cancelled"), successRun("build", 4, CANCELLED_AT, "cancelled")]);

      expect(await read(fake)).toMatchObject({ verdict: "green", detail: "2 runs passed" });
    });

    it("answers red when the later run of the cancelled check failed", async () => {
      const fake = fakeGitHub();
      fake.setRuns(MERGE, [successRun("validate", 3, CANCELLED_AT, "cancelled"), successRun("validate", 7, RERUN_AT, "failure")]);

      expect(await read(fake)).toMatchObject({ verdict: "red", detail: "failed: validate" });
    });

    it("breaks a start-time tie by run id, so the higher id is the newer run", async () => {
      const fake = fakeGitHub();
      fake.setRuns(MERGE, [successRun("validate", 9, RERUN_AT, "cancelled"), successRun("validate", 8, RERUN_AT)]);

      expect((await read(fake)).verdict).toBe("none");
    });

    it("stays pending, never green, while a lone cancelled run has no later run", async () => {
      const fake = fakeGitHub();
      fake.setRuns(MERGE, [successRun("validate", 3, CANCELLED_AT, "cancelled"), successRun("build", 4, CANCELLED_AT)]);

      expect(await read(fake)).toMatchObject({ verdict: "none", detail: expect.stringContaining("waiting for a later run of the same check") });
    });
  });

  it("answers none for a missing merge sha without reading", async () => {
    const fake = fakeGitHub();

    const result = await read(fake, clockedTiming(), { ...input, mergeSha: "" });

    expect(result.verdict).toBe("none");
    expect(fake.calls).not.toContain("listCheckRuns");
  });

  it("answers green when every allowed run passed", async () => {
    const fake = fakeGitHub();
    fake.setRuns(MERGE, [successRun("validate", 1), successRun("dag-check", 2)]);

    expect((await read(fake)).verdict).toBe("green");
    expect(GITHUB_ACTIONS_APP_ID).toBe(15368);
  });
});

type MisroutedTable = Omit<typeof MAIN_CI_ROUTES, "cancelled"> & { readonly cancelled: "read-newer-run" };

describe("a classified main CI read", () => {
  it("carries a newer sha exactly when the table routes it to read-newer-run", () => {
    const superseded: Classified = { read: "cancelled-superseded", newer: MERGE };
    const cancelled: Classified = { read: "cancelled" };
    // @ts-expect-error a read routed to read-newer-run must carry the newer sha
    const missing: Classified = { read: "cancelled-superseded" };

    expect([superseded.read, cancelled.read, missing.read]).toEqual(["cancelled-superseded", "cancelled", "cancelled-superseded"]);
  });

  it("does not type a cancelled read with no newer sha once the table routes cancelled to read-newer-run", () => {
    // @ts-expect-error the edited table sends cancelled to read-newer-run, which needs a newer sha
    const cancelled: Classified<MisroutedTable> = { read: "cancelled" };

    expect(cancelled.read).toBe("cancelled");
  });
});

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** The fake's base requires dag-check beside validate, so a non-empty main read gets its green. */
const withRequired = (runs: ReturnType<typeof successRun>[]) => (runs.length === 0 ? runs : [...runs, successRun("dag-check", 99)]);

function shepherdWorld(mergeRuns: () => ReturnType<typeof successRun>[], cleanup?: CleanupPorts, mainRed?: Omit<MainRedWiring, "freezes">) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const base = githubPort(fake.wire);
  const port = { ...base, checkRuns: async (repo: string, sha: string) => (sha === fake.pr(1).mergeSha && fake.setRuns(sha, withRequired(mergeRuns())), base.checkRuns(repo, sha)) };
  let clock = 0;
  const store = shepherdStoreRef();
  const freeze = freezeStoreRef(() => clock);
  const routes = factoryRoutesFor({ port, store, freeze, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), cleanup, mainRed });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake, store, freezes: () => freeze.get() };
}

async function runToMerge(w: ReturnType<typeof shepherdWorld>, params: Record<string, string> = {}): Promise<string> {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY), ...params });
  await gateOpened(w.host, gateId(runId, "approve-merge"));
  w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
  return runId;
}

const stepIds = (w: ReturnType<typeof shepherdWorld>, runId: string) => Object.values(w.host.runtime.status(runId)!.stepResults).map((result) => result.stepId);

describe("shepherd-pr after land", () => {
  it("records green main CI on the merge sha and opens no gate", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5)]);
    const runId = await runToMerge(w);

    await w.host.runtime.wait(runId);

    const main = Object.values(w.host.runtime.status(runId)!.stepResults).find((result) => result.stepId === "sh-main-ci");
    expect(main?.data).toMatchObject({ result: { verdict: "green", mergeSha: w.fake.pr(1).mergeSha, after: [] } });
  });

  it("cleans up once after green main CI, deleting the merged head branch", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5)]);
    w.fake.pr(1).headRepo = REPO;
    w.fake.refs.set(w.fake.pr(1).headRef, H1);
    const runId = await runToMerge(w);

    await w.host.runtime.wait(runId);

    const cleanup = Object.values(w.host.runtime.status(runId)!.stepResults).filter((result) => result.stepId === "sh-cleanup");
    expect(cleanup.map((result) => result.data)).toMatchObject([{ result: { ref: "deleted", task: "no registration" } }]);
    expect(w.fake.refs.has(w.fake.pr(1).headRef)).toBe(false);
  });

  it("closes the registration's task and retires its implementer through the wired cleanup ports", async () => {
    const closed: string[] = [];
    const retired: string[] = [];
    const cleanup: CleanupPorts = {
      tasks: { state: async () => "open", done: async (initiative, id) => void closed.push(`${initiative}/${id}`), appendNote: async () => undefined },
      agents: { invalidate: () => undefined, roster: async () => (retired.includes("impl-a") ? [] : [{ name: "impl-a", presence: "exited", status: "finished" }]), retire: async (name) => void retired.push(name) },
    };
    const w = shepherdWorld(() => [successRun("validate", 5)], cleanup);
    const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
    w.store.get().register({ repo: REPO, pr: 1, runId, task: "demo/TP-1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    await gateOpened(w.host, gateId(runId, "approve-merge"));
    w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);

    await w.host.runtime.wait(runId);

    expect(closed).toEqual(["demo/TP-1"]);
    expect(retired).toEqual(["impl-a"]);
  });

  it("freezes the repo and offers the owner the release when main is red and no task port is wired", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5, undefined, "failure")]);
    const runId = await runToMerge(w);

    await gateOpened(w.host, gateId(runId, "main-frozen"));
    w.host.runtime.signal(runId, "main-frozen", { decision: "stay-frozen", mergeSha: w.fake.pr(1).mergeSha }, OWNER);
    await w.host.runtime.wait(runId);

    expect(stepIds(w, runId)).toContain("sh-freeze");
    expect(w.freezes().get(REPO)?.redSha).toBe(w.fake.pr(1).mergeSha);
  });

  it("opens no gate and freezes nothing when a later main commit containing a red merge is green on every required context", async () => {
    const TIP = fakeSha("green-descendant");
    const w = shepherdWorld(() => {
      const mergeSha = w.fake.pr(1).mergeSha!;
      w.fake.refs.set("main", TIP);
      w.fake.compares.set(`${mergeSha}...${TIP}`, { mergeBaseSha: mergeSha, files: [] });
      w.fake.setRuns(TIP, [successRun("validate", 6), successRun("dag-check", 7)]);
      return [successRun("validate", 5, undefined, "failure")];
    });
    const runId = await runToMerge(w);

    await w.host.runtime.wait(runId);

    const main = Object.values(w.host.runtime.status(runId)!.stepResults).find((result) => result.stepId === "sh-main-ci");
    expect(main?.data).toMatchObject({ result: { verdict: "green", mergeSha: w.fake.pr(1).mergeSha, acknowledgedSha: TIP } });
    expect(stepIds(w, runId)).not.toContain("sh-freeze");
    expect(w.host.gates.listPending()).toEqual([]);
  });

  it("opens no freeze when each check's cancelled run at the merge sha was re-run green", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5, "2026-10-05T00:29:38Z", "cancelled"), successRun("validate", 6, "2026-10-05T00:31:31Z")]);
    const runId = await runToMerge(w);

    await w.host.runtime.wait(runId);

    expect(stepIds(w, runId)).not.toContain("sh-freeze");
    expect(w.freezes().isFrozen(REPO)).toBe(false);
  });

  it("gates on a non-empty after list and runs no stage", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5)]);
    const runId = await runToMerge(w, { after: JSON.stringify(["deploy", "release"]) });

    await gateOpened(w.host, gateId(runId, "after-stages"));
    const before = stepIds(w, runId);
    w.host.runtime.signal(runId, "after-stages", { decision: "acknowledged", mergeSha: w.fake.pr(1).mergeSha }, OWNER);
    await w.host.runtime.wait(runId);

    expect(before.filter((id) => /deploy|release|activation/.test(id))).toEqual([]);
    expect(stepIds(w, runId).filter((id) => /deploy|release|activation/.test(id))).toEqual([]);
    const main = Object.values(w.host.runtime.status(runId)!.stepResults).find((result) => result.stepId === "sh-main-ci");
    expect(main?.data).toMatchObject({ result: { after: ["deploy", "release"] } });
  });

  it("opens the main-ci-timeout gate when no run appears at the merge sha", async () => {
    const w = shepherdWorld(() => []);
    const runId = await runToMerge(w);

    await gateOpened(w.host, gateId(runId, "main-ci-timeout"));

    const main = Object.values(w.host.runtime.status(runId)!.stepResults).find((result) => result.stepId === "sh-main-ci");
    expect(main?.data).toMatchObject({ result: { verdict: "none" } });
  });

  it("asks once with main-ci-timeout, never main-red, and says no completed run contains the merge, when a run stays queued", async () => {
    const w = shepherdWorld(() => [{ ...successRun("validate", 1), status: "queued", conclusion: null }]);
    const runId = await runToMerge(w);

    await gateOpened(w.host, gateId(runId, "main-ci-timeout"));

    const sha = w.fake.pr(1).mergeSha!;
    expect(JSON.stringify(w.host.gates.get(gateId(runId, "main-ci-timeout")))).toContain(`no completed main run containing ${sha} within 240 min`);
    expect(w.host.gates.get(gateId(runId, "main-red"))).toBeUndefined();
  });

  it("fails a malformed after list before any merge, not after it", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5)]);
    const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY), after: "not json" });

    await w.host.runtime.wait(runId);

    expect(w.host.runtime.status(runId)!.status).toBe("failed");
    expect(w.fake.calls).not.toContain("merge");
    expect(stepIds(w, runId)).not.toContain("merge");
  });
});

const FIXER_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, fixer: true, seat: "demo-seat" };
const EARLIER_RED = fakeSha("earlier-red");
const FIXER = "fix-widget-aaaaaaa";

function mainRedPorts() {
  const added: string[] = [];
  const spawned: string[] = [];
  const mainRed: Omit<MainRedWiring, "freezes"> = {
    tasks: { findByTag: async () => undefined, add: async (_initiative, fields) => `FX-${added.push(fields.title)}` },
    fixers: { roster: async () => spawned.map((name) => ({ name })), spawn: async (name) => void spawned.push(name) },
    checkoutFor: () => tmpdir(),
  };
  return { mainRed, added, spawned };
}

/** Starts a run for PR 1 and registers it before the merge gate, as `shepherd.register` would. */
async function registeredToMerge(w: ReturnType<typeof shepherdWorld>, task: string, implementer: string): Promise<string> {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(FIXER_POLICY) });
  w.store.get().register({ repo: REPO, pr: 1, runId, task, implementer, policy: FIXER_POLICY });
  await gateOpened(w.host, gateId(runId, "approve-merge"));
  w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
  return runId;
}

/** The repo is already frozen at an earlier red with a fix task and a fixer, before PR 1's run starts. */
function frozenWithFixer(w: ReturnType<typeof shepherdWorld>): void {
  const freezes = w.freezes();
  freezes.freeze(REPO, EARLIER_RED);
  freezes.setFixTask(REPO, 1, "demo/FX-1");
  freezes.setFixer(REPO, 1, FIXER);
}

describe("shepherd-pr on a red main", () => {
  it("freezes, files one fix task and spawns one fixer, and asks the owner nothing", async () => {
    const ports = mainRedPorts();
    const w = shepherdWorld(() => [successRun("validate", 5, undefined, "failure")], undefined, ports.mainRed);
    const runId = await registeredToMerge(w, "demo/TP-1", "impl-a");

    await w.host.runtime.wait(runId);

    expect(ports.added).toHaveLength(1);
    expect(ports.spawned).toHaveLength(1);
    expect(w.freezes().get(REPO)).toMatchObject({ fixTask: "demo/FX-1", fixer: ports.spawned[0] });
    expect(w.host.gates.listPending()).toEqual([]);
  });

  it("finishes and cleans up, gating nothing, when main goes green and thaws the repo while the fixer spawns", async () => {
    const ports = mainRedPorts();
    let thaw = (): void => undefined;
    const fixers = ports.mainRed.fixers!;
    const mainRed = { ...ports.mainRed, fixers: { ...fixers, spawn: async (name: string, brief: string, cwd: string) => (thaw(), fixers.spawn(name, brief, cwd)) } };
    const w = shepherdWorld(() => [successRun("validate", 5, undefined, "failure")], undefined, mainRed);
    thaw = () => void w.freezes().unfreeze(REPO, fakeSha("green"));
    const runId = await registeredToMerge(w, "demo/TP-1", "impl-a");

    await w.host.runtime.wait(runId);

    expect(w.host.runtime.status(runId)!.status).toBe("completed");
    expect(stepIds(w, runId)).toContain("sh-cleanup");
    expect(w.host.gates.listPending()).toEqual([]);
    expect(w.freezes().isFrozen(REPO)).toBe(false);
  });

  it("opens main-red-again on a red at the fixer's own merge, spawns no second fixer, and thaws on the owner's word", async () => {
    const ports = mainRedPorts();
    const w = shepherdWorld(() => [successRun("validate", 5, undefined, "failure")], undefined, ports.mainRed);
    frozenWithFixer(w);
    const runId = await registeredToMerge(w, "demo/FX-1", FIXER);

    await gateOpened(w.host, gateId(runId, "main-red-again"));
    const before = { added: ports.added.length, spawned: ports.spawned.length };
    w.host.runtime.signal(runId, "main-red-again", { decision: "unfreeze", mergeSha: w.fake.pr(1).mergeSha }, OWNER);
    await w.host.runtime.wait(runId);

    expect(before).toEqual({ added: 0, spawned: 0 });
    expect(ports.spawned).toEqual([]);
    expect(w.freezes().isFrozen(REPO)).toBe(false);
  });

  it("unfreezes when the fixer's merge is green", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5)], undefined, mainRedPorts().mainRed);
    frozenWithFixer(w);
    const runId = await registeredToMerge(w, "demo/FX-1", FIXER);

    await w.host.runtime.wait(runId);

    expect(w.freezes().isFrozen(REPO)).toBe(false);
  });

  it("neither freezes nor unfreezes when no run appears at the merge sha", async () => {
    const w = shepherdWorld(() => [], undefined, mainRedPorts().mainRed);
    frozenWithFixer(w);
    const runId = await registeredToMerge(w, "demo/FX-1", FIXER);

    await gateOpened(w.host, gateId(runId, "main-ci-timeout"));

    expect(w.freezes().get(REPO)).toMatchObject({ redSha: EARLIER_RED, redCount: 1 });
    expect(stepIds(w, runId)).not.toContain("sh-freeze");
    expect(stepIds(w, runId)).not.toContain("sh-unfreeze");
  });

  it("files a task, spawns nothing and thaws on the owner's word when the policy grants no fixer", async () => {
    const ports = mainRedPorts();
    const w = shepherdWorld(() => [successRun("validate", 5, undefined, "failure")], undefined, ports.mainRed);
    const runId = await runToMerge(w);

    await gateOpened(w.host, gateId(runId, "main-frozen"));
    const frozenAtGate = w.freezes().isFrozen(REPO);
    w.host.runtime.signal(runId, "main-frozen", { decision: "unfreeze", mergeSha: w.fake.pr(1).mergeSha }, OWNER);
    await w.host.runtime.wait(runId);

    expect(ports.added).toHaveLength(1);
    expect(ports.spawned).toEqual([]);
    expect(frozenAtGate).toBe(true);
    expect(w.freezes().isFrozen(REPO)).toBe(false);
  });

  it("refuses an unfreeze answer from an earlier episode's gate once a later red has frozen the repo again", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5, undefined, "failure")], undefined, mainRedPorts().mainRed);
    const runId = await runToMerge(w);
    await gateOpened(w.host, gateId(runId, "main-frozen"));
    const freezes = w.freezes();
    freezes.unfreeze(REPO, fakeSha("hand-fix"));
    freezes.freeze(REPO, EARLIER_RED);
    freezes.setFixTask(REPO, 2, "demo/FX-2");
    freezes.setFixer(REPO, 2, FIXER);

    w.host.runtime.signal(runId, "main-frozen", { decision: "unfreeze", mergeSha: w.fake.pr(1).mergeSha }, OWNER);
    await w.host.runtime.wait(runId);

    expect(freezes.get(REPO)).toMatchObject({ episode: 2, redSha: EARLIER_RED, fixer: FIXER });
  });

  it("thaws on the owner's word when no fix task could be filed", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5, undefined, "failure")], undefined, { ...mainRedPorts().mainRed, tasks: undefined });
    const runId = await registeredToMerge(w, "demo/TP-1", "impl-a");

    await gateOpened(w.host, gateId(runId, "main-frozen"));
    w.host.runtime.signal(runId, "main-frozen", { decision: "unfreeze", mergeSha: w.fake.pr(1).mergeSha }, OWNER);
    await w.host.runtime.wait(runId);

    expect(w.freezes().isFrozen(REPO)).toBe(false);
  });

  it("offers the owner the release when the fixer's green merge skipped a check that was red, and thaws on the owner's word", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5)], undefined, mainRedPorts().mainRed);
    w.fake.rules = { contexts: [], strict: false };
    w.fake.setRuns(EARLIER_RED, [successRun("docs", 4, undefined, "failure")]);
    frozenWithFixer(w);
    const runId = await registeredToMerge(w, "demo/FX-1", FIXER);

    await gateOpened(w.host, gateId(runId, "main-frozen"));
    const frozenAtGate = w.freezes().isFrozen(REPO);
    w.host.runtime.signal(runId, "main-frozen", { decision: "unfreeze", mergeSha: w.fake.pr(1).mergeSha }, OWNER);
    await w.host.runtime.wait(runId);

    expect(frozenAtGate).toBe(true);
    expect(w.freezes().isFrozen(REPO)).toBe(false);
  });

  it("opens no gate when the fixer's green merge thaws the repo", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5)], undefined, mainRedPorts().mainRed);
    frozenWithFixer(w);
    const runId = await registeredToMerge(w, "demo/FX-1", FIXER);

    await w.host.runtime.wait(runId);

    expect(stepIds(w, runId)).not.toContain("main-frozen");
  });
});

describe("post-merge gate briefs", () => {
  const MAIN_RUNS = (sha: string) => new RegExp(`^\\$ gh run list -R ${REPO} -c ${sha}$`);

  it("opens main-ci-timeout with a summary naming the merge sha and an evidence command", async () => {
    const w = shepherdWorld(() => []);
    const runId = await runToMerge(w);

    await gateOpened(w.host, gateId(runId, "main-ci-timeout"));

    const sha = w.fake.pr(1).mergeSha!;
    expectBrief(w.host.gates.get(gateId(runId, "main-ci-timeout")), sha, MAIN_RUNS(sha));
  });

  it("opens after-stages with a summary naming the merge sha and an evidence command", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5)]);
    const runId = await runToMerge(w, { after: JSON.stringify(["deploy", "release"]) });

    await gateOpened(w.host, gateId(runId, "after-stages"));

    const sha = w.fake.pr(1).mergeSha!;
    const gate = w.host.gates.get(gateId(runId, "after-stages"));
    expectBrief(gate, sha, MAIN_RUNS(sha));
    expect(gate?.summary).toContain("deploy, release");
  });

  it("opens main-frozen with a summary naming the merge sha and an evidence command", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5, undefined, "failure")]);
    const runId = await runToMerge(w);

    await gateOpened(w.host, gateId(runId, "main-frozen"));

    const sha = w.fake.pr(1).mergeSha!;
    const gate = w.host.gates.get(gateId(runId, "main-frozen"));
    expectBrief(gate, sha, MAIN_RUNS(sha));
    expect(gate?.questions?.[0]?.options.find((option) => option.recommended)?.id).toBe("stay-frozen");
  });

  it("opens main-red-again with a summary naming the merge sha and an evidence command", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5, undefined, "failure")], undefined, mainRedPorts().mainRed);
    frozenWithFixer(w);
    const runId = await registeredToMerge(w, "demo/FX-1", FIXER);

    await gateOpened(w.host, gateId(runId, "main-red-again"));

    const sha = w.fake.pr(1).mergeSha!;
    expectBrief(w.host.gates.get(gateId(runId, "main-red-again")), sha, MAIN_RUNS(sha));
  });
});
