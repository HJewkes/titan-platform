import { GITHUB_ACTIONS_APP_ID, fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { readMainCi, SH_MAIN_CI_TIMEOUT_MS, type MainCiInput } from "./post-merge.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdStoreRef } from "./store.js";

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

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function shepherdWorld(mergeRuns: () => ReturnType<typeof successRun>[]) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const base = githubPort(fake.wire);
  const port = { ...base, checkRuns: async (repo: string, sha: string) => (sha === fake.pr(1).mergeSha && fake.setRuns(sha, mergeRuns()), base.checkRuns(repo, sha)) };
  let clock = 0;
  const routes = factoryRoutesFor({ port, store: shepherdStoreRef(), now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake };
}

async function runToMerge(w: ReturnType<typeof shepherdWorld>, params: Record<string, string> = {}): Promise<string> {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY), ...params });
  await gateOpened(w.host, gateId(runId, "approve-merge"));
  w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 });
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

  it("opens the main-red gate for the owner when main is red", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5, undefined, "failure")]);
    const runId = await runToMerge(w);

    await gateOpened(w.host, gateId(runId, "main-red"));
    w.host.runtime.signal(runId, "main-red", { decision: "acknowledged", mergeSha: w.fake.pr(1).mergeSha });
    await w.host.runtime.wait(runId);

    expect(stepIds(w, runId)).not.toContain("sh-freeze");
  });

  it("gates on a non-empty after list and runs no stage", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5)]);
    const runId = await runToMerge(w, { after: JSON.stringify(["deploy", "release"]) });

    await gateOpened(w.host, gateId(runId, "after-stages"));
    const before = stepIds(w, runId);
    w.host.runtime.signal(runId, "after-stages", { decision: "acknowledged", mergeSha: w.fake.pr(1).mergeSha });
    await w.host.runtime.wait(runId);

    expect(before.filter((id) => /deploy|release|activation/.test(id))).toEqual([]);
    expect(stepIds(w, runId).filter((id) => /deploy|release|activation/.test(id))).toEqual([]);
    const main = Object.values(w.host.runtime.status(runId)!.stepResults).find((result) => result.stepId === "sh-main-ci");
    expect(main?.data).toMatchObject({ result: { after: ["deploy", "release"] } });
  });

  it("opens the main-red gate when no run appears at the merge sha", async () => {
    const w = shepherdWorld(() => []);
    const runId = await runToMerge(w);

    await gateOpened(w.host, gateId(runId, "main-red"));

    const main = Object.values(w.host.runtime.status(runId)!.stepResults).find((result) => result.stepId === "sh-main-ci");
    expect(main?.data).toMatchObject({ result: { verdict: "none" } });
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
