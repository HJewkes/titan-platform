import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { LEAKY_MESSAGE, expectNoLeak } from "../test-support/leak.js";
import { BRANCH, callCommand, shepherdFixture, shepherdRuns, type ShepherdFixture } from "../test-support/shepherd.js";
import { REGISTRY_BACKOFF_MS, VERSION_PACKAGES_BRANCH, type PackageRegistry } from "./release.js";
import { START_CI_AFTER_MS, START_CI_MESSAGE, startCiIfIdle, sweepVersionPackages } from "./version-packages.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const VP_HEAD = fakeSha("version-packages");
const NOW = Date.parse("2026-01-01T12:00:00Z");

interface World extends ShepherdFixture {
  host: FactoryHost;
}

/** A repo Shepherd already watches, through one registered PR, with an open Version Packages PR beside it. */
async function watchedRepo(): Promise<World & { vp: number }> {
  const fixture = shepherdFixture({ frozen: true });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
  const envelope = await callCommand(host, fixture.routes, "shepherd.register", { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a" });
  if (!envelope.ok) throw new Error(envelope.error);
  const vp = fixture.fake.addPr({ headSha: VP_HEAD, headRef: VERSION_PACKAGES_BRANCH, headRepo: REPO }).number;
  fixture.fake.setRuns(VP_HEAD, [successRun("validate", 7)]);
  return { ...fixture, host, vp };
}

const sweep = (w: World) => sweepVersionPackages(w.host, w.routes.shepherd!, () => NOW);

describe("sweepVersionPackages", () => {
  it("registers an open Version Packages PR once, with no fixer, and leaves the live run alone on the next sweep", async () => {
    const w = await watchedRepo();

    const first = await sweep(w);
    const second = await sweep(w);
    const registration = w.routes.shepherd!.store.get().byPr(REPO, w.vp);

    expect(first).toEqual([{ repo: REPO, pr: w.vp, registered: registration?.runId }]);
    expect(second).toEqual([]);
    expect(registration).toMatchObject({ task: "demo/version-packages", implementer: "changesets", branch: VERSION_PACKAGES_BRANCH, policy: { fixer: false } });
    expect(shepherdRuns(w.host)).toHaveLength(2);
  });

  it("registers the next Version Packages PR from the reused branch once the last one's run has finished", async () => {
    const w = await watchedRepo();
    await sweep(w);
    const store = w.routes.shepherd!.store.get();
    const last = store.byPr(REPO, w.vp)!;
    w.host.runtime.cancel(last.runId, "merged in this test");
    await w.host.runtime.wait(last.runId);
    Object.assign(w.fake.pr(w.vp), { state: "closed", merged: true });
    const next = w.fake.addPr({ headSha: fakeSha("next-release"), headRef: VERSION_PACKAGES_BRANCH, headRepo: REPO }).number;
    w.fake.setRuns(fakeSha("next-release"), [successRun("validate", 8)]);

    const notes = await sweep(w);

    expect(notes).toMatchObject([{ pr: next, registered: expect.any(String) }]);
    expect(store.byPr(REPO, next)?.branch).toBe(VERSION_PACKAGES_BRANCH);
    expect(store.byRun(last.runId)?.branch).toBeNull();
  });

  it("notes a repo whose Version Packages PR could not be looked up, with the lookup's status, never its text, and registers nothing", async () => {
    const w = await watchedRepo();
    const services = w.routes.shepherd!;
    const failing = { ...services, port: { ...services.port, findPr: async () => Promise.reject(Object.assign(new Error(LEAKY_MESSAGE), { status: 502 })) } };

    const notes = await sweepVersionPackages(w.host, failing, () => NOW);

    expect(notes).toEqual([{ repo: REPO, error: "HTTP 502" }]);
    expectNoLeak(notes);
    expect(shepherdRuns(w.host)).toHaveLength(1);
  });

  it("looks only in repos Shepherd already watches", async () => {
    const fixture = shepherdFixture({ frozen: true });
    const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
    hosts.push(host);
    fixture.fake.addPr({ headSha: VP_HEAD, headRef: VERSION_PACKAGES_BRANCH, headRepo: REPO });

    expect(await sweepVersionPackages(host, fixture.routes.shepherd!, () => NOW)).toEqual([]);
    expect(shepherdRuns(host)).toEqual([]);
  });
});

describe("sweepVersionPackages and the release preflight", () => {
  const BASE = fakeSha("release-base");
  const WIDGET = "packages/widget/package.json";

  /** A watched repo whose Version Packages PR bumps one public package; `registry` answers both the run and the sweep. */
  async function releaseRepo(registry: PackageRegistry, headManifest = JSON.stringify({ name: "@demo/widget", version: "1.1.0" })) {
    const fixture = shepherdFixture({ registry });
    const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
    hosts.push(host);
    fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
    const envelope = await callCommand(host, fixture.routes, "shepherd.register", { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a" });
    if (!envelope.ok) throw new Error(envelope.error);
    const vp = fixture.fake.addPr({ headSha: VP_HEAD, headRef: VERSION_PACKAGES_BRANCH, headRepo: REPO }).number;
    fixture.fake.prFiles.set(vp, [{ path: WIDGET, status: "modified" }]);
    fixture.fake.compares.set(`main...${VP_HEAD}`, { mergeBaseSha: BASE, files: [] });
    fixture.fake.files.set(`${BASE}:${WIDGET}`, { content: JSON.stringify({ name: "@demo/widget", version: "1.0.0" }), blobSha: "w0" });
    fixture.fake.files.set(`${VP_HEAD}:${WIDGET}`, { content: headManifest, blobSha: "w1" });
    const w = { ...fixture, host, vp };
    const sweepNow = () => sweepVersionPackages(host, fixture.routes.shepherd!, () => NOW, registry);
    const runOf = () => w.routes.shepherd!.store.get().byPr(REPO, vp)!.runId;
    const preflightOf = (runId: string) => Object.values(host.runtime.status(runId)!.stepResults).find((step) => step.stepId === `sh-release-preflight:${VP_HEAD}`)?.data?.result;
    return { ...w, sweepNow, runOf, preflightOf };
  }

  it("retries a registry that cannot be read, stores no blocked result for the head, and the next sweep reads it again", async () => {
    let reads = 0;
    const w = await releaseRepo(async () => {
      reads += 1;
      if (reads <= REGISTRY_BACKOFF_MS.length + 1) throw new Error("registry.npmjs.org answered 503 for @demo/widget");
      return true;
    });

    await w.sweepNow();
    const first = await w.host.runtime.wait(w.runOf());
    const notes = await w.sweepNow();
    await gateOpened(w.host, gateId(w.runOf(), "approve-merge"));

    expect([first.status, first.error]).toEqual(["failed", expect.stringContaining("answered 503")]);
    expect(w.preflightOf(first.id)).toBeUndefined();
    expect(notes).toEqual([{ repo: REPO, pr: w.vp, registered: w.runOf() }]);
    expect(w.preflightOf(w.runOf())).toEqual({ head: VP_HEAD, blockers: [], packages: ["@demo/widget"], unpublished: [] });
  });

  it("re-reads npm for a head blocked only by an unpublished package, and starts a fresh run once it is published by hand", async () => {
    const published = new Set<string>();
    const w = await releaseRepo(async (name) => published.has(name));
    await w.sweepNow();
    const blocked = w.runOf();
    await gateOpened(w.host, gateId(blocked, "approve-merge"));

    const beforePublish = await w.sweepNow();
    published.add("@demo/widget");
    const afterPublish = await w.sweepNow();
    await gateOpened(w.host, gateId(w.runOf(), "approve-merge"));

    expect(beforePublish).toEqual([]);
    expect(afterPublish).toEqual([{ repo: REPO, pr: w.vp, unblocked: gateId(blocked, "approve-merge"), registered: w.runOf() }]);
    expect(w.host.runtime.status(blocked)?.status).toBe("failed");
    expect(w.preflightOf(blocked)).toMatchObject({ unpublished: ["@demo/widget"] });
    expect(w.preflightOf(w.runOf())).toMatchObject({ blockers: [], unpublished: [] });
  });

  it("gates a malformed manifest once, and the next sweep leaves that run waiting on the owner", async () => {
    const w = await releaseRepo(async () => true, "{ not json");
    await w.sweepNow();
    const runId = w.runOf();
    await gateOpened(w.host, gateId(runId, "approve-merge"));

    const notes = await w.sweepNow();

    expect(notes).toEqual([]);
    expect([w.runOf(), w.host.runtime.status(runId)?.status]).toEqual([runId, "paused"]);
    expect(w.preflightOf(runId)).toMatchObject({ blockers: [`${WIDGET} is not a readable package manifest at ${VP_HEAD}`] });
  });
});

describe("startCiIfIdle", () => {
  const PARENT = fakeSha("main-tip");

  /** The changesets action's head: a real change on top of main, pushed `ageMs` ago, with no check run. */
  function idleHead(ageMs: number, tree = "tree-release"): FakeGitHub {
    const fake = fakeGitHub();
    fake.addPr({ headSha: VP_HEAD, headRef: VERSION_PACKAGES_BRANCH, headRepo: REPO });
    fake.refs.set(VERSION_PACKAGES_BRANCH, VP_HEAD);
    fake.commits.set(PARENT, { sha: PARENT, parents: [], tree: "tree-main" });
    fake.commits.set(VP_HEAD, { sha: VP_HEAD, parents: [PARENT], tree, committedAt: new Date(NOW - ageMs).toISOString() });
    return fake;
  }

  const start = (fake: FakeGitHub) => startCiIfIdle(githubPort(fake.wire), REPO, fake.pr(1), () => NOW);

  it("pushes one empty commit onto a head that never started CI, and the PR moves to it", async () => {
    const fake = idleHead(START_CI_AFTER_MS);

    const pushed = await start(fake);

    expect(pushed).toBe(fake.refs.get(VERSION_PACKAGES_BRANCH));
    expect(fake.commits.get(pushed!)).toEqual({ sha: pushed, parents: [VP_HEAD], tree: "tree-release" });
    expect([fake.pr(1).headSha, fake.effects.updateRef]).toEqual([pushed, 1]);
    expect(START_CI_MESSAGE).toMatch(/TP-447/);
  });

  it("leaves a head alone that has an Actions run", async () => {
    const fake = idleHead(START_CI_AFTER_MS);
    fake.setRuns(VP_HEAD, [{ ...successRun("validate", 1), status: "queued", conclusion: null }]);

    expect(await start(fake)).toBeUndefined();
    expect(fake.effects.updateRef).toBe(0);
  });

  it("waits out the grace on a head pushed moments ago, whose CI may still be starting", async () => {
    const fake = idleHead(START_CI_AFTER_MS - 1);

    expect(await start(fake)).toBeUndefined();
  });

  it("never pushes onto an empty commit, so Actions being down costs one commit, not one per sweep", async () => {
    const fake = idleHead(START_CI_AFTER_MS, "tree-main");

    expect(await start(fake)).toBeUndefined();
    expect(fake.calls).not.toContain("createCommit");
  });
});
