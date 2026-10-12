import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import type { FixTaskFields } from "./main-red.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { VERSION_PACKAGES_BRANCH } from "./release.js";
import { RELEASE_FOLLOW_STEP, type VersionRegistry } from "./release-follow.js";
import { shepherdStoreRef } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const RELEASE_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", release: "grant", seat: "trusted-seat" };
const BASE = fakeSha("base");
const WIDGET = "packages/widget/package.json";
const RELEASE_FILES = [
  { path: WIDGET, status: "modified" },
  { path: "packages/widget/CHANGELOG.md", status: "modified" },
  { path: ".changeset/brave-otters.md", status: "removed" },
];

interface Scene {
  /** Main CI on the merge commit; `failure` makes main red. */
  main?: string;
  /** The Release workflow's job on the merge commit. */
  release?: string;
  registry?: VersionRegistry;
}

/** PR 1 merges; its main CI and release job conclude as the scene says, and every filed fix task is kept. */
function world(scene: Scene, headRef = VERSION_PACKAGES_BRANCH) {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.addPr({ headSha: H1, headRef, headRepo: REPO });
  fake.prFiles.set(1, RELEASE_FILES);
  fake.files.set(`${BASE}:${WIDGET}`, { content: JSON.stringify({ name: "@demo/widget", version: "1.0.0" }), blobSha: "b0" });
  fake.files.set(`${H1}:${WIDGET}`, { content: JSON.stringify({ name: "@demo/widget", version: "1.1.0" }), blobSha: "b1" });
  const mergeRuns = [successRun("validate", 5, undefined, scene.main ?? "success"), successRun("dag-check", 6), successRun("release", 7, undefined, scene.release ?? "success")];
  const base = githubPort(fake.wire);
  const port = { ...base, checkRuns: async (repo: string, sha: string) => (sha === fake.pr(1).mergeSha && fake.setRuns(sha, mergeRuns), base.checkRuns(repo, sha)) };
  const filed: FixTaskFields[] = [];
  const tasks = { findByTag: async () => undefined, add: async (_initiative: string, fields: FixTaskFields) => `FX-${filed.push(fields)}` };
  let clock = 0;
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port, store, now: () => clock, sleep: async (ms, signal) => (signal.throwIfAborted(), void (clock += ms)), registry: async () => "trusted", versions: scene.registry ?? (async () => true), mainRed: { tasks } });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake, store, filed };
}

function startRelease(w: ReturnType<typeof world>): string {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", branch: VERSION_PACKAGES_BRANCH, policy: JSON.stringify(RELEASE_POLICY) });
  w.store.get().register({ repo: REPO, pr: 1, branch: VERSION_PACKAGES_BRANCH, runId, task: "demo/version-packages", implementer: "changesets", policy: RELEASE_POLICY });
  return runId;
}

const resultOf = (w: ReturnType<typeof world>, runId: string, stepId: string) => Object.values(w.host.runtime.status(runId)!.stepResults).find((result) => result.stepId === stepId)?.data?.result;
const followOf = (w: ReturnType<typeof world>, runId: string) => resultOf(w, runId, RELEASE_FOLLOW_STEP);
const mainCiOf = (w: ReturnType<typeof world>, runId: string) => resultOf(w, runId, "sh-main-ci");

describe("shepherd-pr follows a merged Version Packages PR to npm", () => {
  it("records the release as published with its versions once main CI is green and npm serves them, and completes", async () => {
    const w = world({});
    const runId = startRelease(w);

    const done = await w.host.runtime.wait(runId);

    expect(w.fake.pr(1).merged).toBe(true);
    expect(done.status).toBe("completed");
    expect(followOf(w, runId)).toMatchObject({ outcome: "published", versions: { "@demo/widget": "1.1.0" }, missing: [] });
  });

  it("files one fix task when the release job failed, opens no gate, and completes", async () => {
    const w = world({ release: "failure", registry: async () => false });
    const runId = startRelease(w);

    const done = await w.host.runtime.wait(runId);

    expect(done.status).toBe("completed");
    expect(followOf(w, runId)).toMatchObject({ outcome: "failed", task: "demo/FX-1", missing: ["@demo/widget@1.1.0"] });
    expect(w.filed).toHaveLength(1);
    expect(w.filed[0]!.tags).toContain(`release-red:${REPO}:${w.fake.pr(1).mergeSha}`);
    expect(w.host.gates.listPending()).toEqual([]);
  });

  it("does not follow the release when main CI on the merge is red", async () => {
    const w = world({ main: "failure" });
    const runId = startRelease(w);

    await vi.waitFor(() => expect(w.host.runtime.status(runId)?.status).toBe("paused"), { timeout: 10_000 });

    expect(mainCiOf(w, runId)).toMatchObject({ verdict: "red" });
    expect(followOf(w, runId)).toBeUndefined();
  });

  it("does not follow a release after an ordinary PR merges", async () => {
    const w = world({}, "agent-chat/demo-1");
    const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
    await gateOpened(w.host, gateId(runId, "approve-merge"));
    w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);

    await w.host.runtime.wait(runId);

    expect(w.fake.pr(1).merged).toBe(true);
    expect(followOf(w, runId)).toBeUndefined();
  });
});
