import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type GitHubPort } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { configuredRoutes, factoryRoutesFor, type FactoryRouteDeps } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { landPrWorkflow } from "../workflows/land-pr.js";
import { AdvisoryRefused, advisoryGuard, advisoryPort, stickyAdvisory } from "./advisory.js";
import type { ShepherdPhases } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { mergeVerdict } from "./review.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";

const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const locator: SourceTextLocator = {
  source: {
    sourceId: "transcript-1",
    harness: "claude-code",
    format: "jsonl",
    formatVersion: null,
    path: "/transcripts/transcript-1.jsonl",
    namespace: "test",
    conversation: { harness: "claude-code", namespace: "test", nativeId: "session-rv-1" },
    provenance: { kind: "native", name: "test" },
  },
  evidence: {
    line: { sourceId: "transcript-1", byteOffset: 0, byteLength: 1, contentHash: "0".repeat(64), lineNumber: 1, nativeOrdinal: null },
    subrecord: { index: 0, path: [] },
  },
  selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
};
const MERGE_SHA = fakeSha("advisory-merge");
const H2 = fakeSha("advisory-head-2");
const hosts: FactoryHost[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

interface World {
  fake: FakeGitHub;
  host: FactoryHost;
  /** Every write the port under the factory was asked for, by method name. */
  writes: string[];
  /** How many reviews the run asked for. */
  reviews: { asked: number };
  flag: { advisory: boolean };
  store: ShepherdStore;
}

/** Records each branch write before the fake sees it, so a refusal above the port is told apart from one by GitHub. */
function recordingPort(fake: FakeGitHub, writes: string[]): GitHubPort {
  const port = githubPort(fake.wire);
  return {
    ...port,
    merge: async (...args) => (writes.push("merge"), port.merge(...args)),
    updateBranch: async (...args) => (writes.push("updateBranch"), port.updateBranch(...args)),
    pushEmptyCommit: async (...args) => (writes.push("pushEmptyCommit"), port.pushEmptyCommit(...args)),
    deleteRef: async (...args) => (writes.push("deleteRef"), port.deleteRef(...args)),
    checkRuns: async (slug, sha) => (sha === MERGE_SHA && fake.setRuns(sha, [successRun("validate", 9), successRun("dag-check", 10)]), port.checkRuns(slug, sha)),
  };
}

type Routed = Pick<FactoryRouteDeps, "port" | "store" | "now" | "sleep" | "registry">;

/**
 * PR 1 at H1 is green on a strict repo; its reviewer answers MERGE under an auto policy, so only the advisory flag
 * stands between it and a merge. `env` builds the production routes over that config home instead of the test's flag.
 */
function world(options: { behind?: boolean; env?: NodeJS.ProcessEnv } = {}): World {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.addPr({ headSha: H1, mergeSha: MERGE_SHA, behind: options.behind ?? false });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  const writes: string[] = [];
  const reviews = { asked: 0 };
  const flag = { advisory: true };
  const review: ShepherdPhases["review"] = (ctx, request) => (reviews.asked++, mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"] }));
  const store = shepherdStoreRef();
  let clock = 0;
  const tick = async (ms: number, signal: AbortSignal) => ((clock += ms), sleep(1, signal));
  const deps: Routed = { port: recordingPort(fake, writes), store, now: () => clock, sleep: tick, registry: async () => "trusted" as const };
  const routes = options.env ? configuredRoutes(options.env, deps) : factoryRoutesFor({ ...deps, advisory: (repo) => flag.advisory && repo === REPO });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review, wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }) }), landPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { fake, host, writes, reviews, flag, store: store.get() };
}

function shepherd(w: World): string {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO_POLICY) });
  w.store.register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-1", policy: AUTO_POLICY });
  return runId;
}

/** Long enough for many hold polls on the fake clock, so a merge that was going to happen would have. */
const settle = () => sleep(200, new AbortController().signal);

async function heldAt(w: World, runId: string, step: RegExp): Promise<void> {
  await vi.waitFor(() => expect(w.host.runtime.status(runId)?.currentStep).toMatch(step), { timeout: 5_000 });
  await settle();
}

describe("an advisory repo under an auto policy", () => {
  it("reviews a green PR with a MERGE verdict and holds the merge, with no merge call reaching the port", async () => {
    const w = world();

    const runId = shepherd(w);
    await heldAt(w, runId, /^merge:/);

    expect(w.reviews.asked).toBe(1);
    expect(w.host.runtime.status(runId)?.status).toBe("running");
    expect(w.host.runtime.status(runId)?.currentStep).toMatch(/^merge:/);
    expect(w.fake.effects.merge).toBe(0);
    expect(w.writes).toEqual([]);
  });

  it("never updates a PR that is behind on a strict repo", async () => {
    const w = world({ behind: true });

    const runId = shepherd(w);
    await heldAt(w, runId, /^update-branch:/);

    expect(w.host.runtime.status(runId)?.status).toBe("running");
    expect(w.fake.effects.updateBranch).toBe(0);
    expect(w.writes).toEqual([]);
  });

  it("reviews a head pushed while the merge is held, and holds the new head too", async () => {
    const w = world();
    const runId = shepherd(w);
    await heldAt(w, runId, /^merge:/);

    w.fake.pr(1).headSha = H2;
    await vi.waitFor(() => expect(w.reviews.asked).toBe(2), { timeout: 5_000 });
    await heldAt(w, runId, /^merge:/);

    expect(w.host.runtime.status(runId)?.status).toBe("running");
    expect(w.fake.effects.merge).toBe(0);
    expect(w.writes).toEqual([]);
  });

  it("merges the held PR on its next poll once the flag is cleared", async () => {
    const w = world();
    const runId = shepherd(w);
    await heldAt(w, runId, /^merge:/);

    w.flag.advisory = false;
    await vi.waitFor(() => expect(w.fake.effects.merge).toBe(1), { timeout: 5_000 });

    expect(w.writes).toEqual(["merge"]);
    expect(w.reviews.asked).toBe(1);
  });
});

/** A config home whose `shepherd.repos` is `repos`; the returned writer rewrites the file in place. */
function configHome(repos: object): { env: NodeJS.ProcessEnv; file: string } {
  const home = mkdtempSync(join(tmpdir(), "factory-advisory-"));
  dirs.push(home);
  mkdirSync(join(home, "titan-factory"));
  const file = join(home, "titan-factory", "config.json");
  writeFileSync(file, JSON.stringify({ shepherd: { repos } }));
  return { env: { XDG_CONFIG_HOME: home }, file };
}

describe("advisory read from shepherd.repos", () => {
  it.each([
    ["moved away", (file: string) => rmSync(file)],
    ["half written", (file: string) => writeFileSync(file, '{"shepherd": {"rep')],
    ["holding an entry that cannot be read", (file: string) => writeFileSync(file, JSON.stringify({ shepherd: { repos: { [REPO]: { advisory: "yes" } } } }))],
  ])("keeps a held merge held while the config file is %s", async (_case, spoil) => {
    const { env, file } = configHome({ [REPO]: { advisory: true } });
    const w = world({ env });
    const runId = shepherd(w);
    await heldAt(w, runId, /^merge:/);

    spoil(file);
    await settle();

    expect(w.host.runtime.status(runId)?.status).toBe("running");
    expect(w.host.runtime.status(runId)?.currentStep).toMatch(/^merge:/);
    expect(w.fake.effects.merge).toBe(0);
    expect(w.writes).toEqual([]);
  });

  it("holds the merge when a key that differs only in case is advisory and a later one is not", async () => {
    const { env } = configHome({ [REPO]: { advisory: true }, [REPO.toUpperCase()]: { path: "/srv/checkouts/demo" } });
    const w = world({ env });

    const runId = shepherd(w);
    await heldAt(w, runId, /^merge:/);

    expect(w.fake.effects.merge).toBe(0);
    expect(w.writes).toEqual([]);
  });
});

describe("stickyAdvisory", () => {
  it("lets a successful read clear the flag, and keeps it through a read that throws or finds no file", () => {
    const reads: (() => Record<string, { advisory?: boolean }> | undefined)[] = [() => ({ [REPO]: { advisory: true } }), () => undefined, () => { throw new Error("invalid config"); }, () => ({})];
    const isAdvisory = stickyAdvisory(() => reads.shift()!());

    const answers = [isAdvisory(REPO), isAdvisory(REPO), isAdvisory(REPO)];

    expect(answers).toEqual([true, true, false]);
  });

  it("keeps a repo advisory that was never asked about before the file went missing", () => {
    const reads: (() => Record<string, { advisory?: boolean }> | undefined)[] = [() => ({ [REPO]: { advisory: true } }), () => ({ [REPO]: { advisory: true } }), () => undefined];
    const isAdvisory = stickyAdvisory(() => reads.shift()!());
    isAdvisory("octo/other");

    expect(isAdvisory(REPO)).toBe(true);
  });
});

describe("advisoryGuard", () => {
  it("names advisory as the reason for an advisory repo and gives none for another", async () => {
    const guard = advisoryGuard((repo) => repo === REPO);
    const port = githubPort(fakeGitHub().wire);

    expect(await guard.reason(port, REPO, 1, "main")).toMatch(/advisory/);
    expect(await guard.reason(port, "octo/other", 1, "main")).toBeUndefined();
  });
});

describe("advisoryPort", () => {
  it("refuses merge, updateBranch, pushEmptyCommit and deleteRef for an advisory repo, before GitHub sees them", async () => {
    const writes: string[] = [];
    const port = advisoryPort(recordingPort(fakeGitHub(), writes), (repo) => repo === REPO);

    await expect(port.merge(REPO, 1, H1, "squash")).rejects.toThrow(AdvisoryRefused);
    await expect(port.updateBranch(REPO, 1, H1)).rejects.toThrow(AdvisoryRefused);
    await expect(port.pushEmptyCommit(REPO, "topic", H1, "retrigger")).rejects.toThrow(AdvisoryRefused);
    await expect(port.deleteRef(REPO, { branch: "topic", repo: REPO })).rejects.toThrow(AdvisoryRefused);
    expect(writes).toEqual([]);
  });

  it("passes every write through for a repo that is not advisory", async () => {
    const writes: string[] = [];
    const port = advisoryPort(recordingPort(fakeGitHub(), writes), () => false);

    await Promise.allSettled([port.merge(REPO, 1, H1, "squash"), port.updateBranch(REPO, 1, H1), port.pushEmptyCommit(REPO, "topic", H1, "retrigger"), port.deleteRef(REPO, { branch: "topic", repo: REPO })]);

    expect(writes).toEqual(["merge", "updateBranch", "pushEmptyCommit", "deleteRef"]);
  });
});
