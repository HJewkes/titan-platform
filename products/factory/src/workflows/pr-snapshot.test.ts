import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type FakeGitHub, type GitHubWire } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow } from "../definition.js";
import type { GatePolicy } from "../gate-policy.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { readCi, type CiSnapshot } from "./land-ci.js";
import { LAND_STEPS, land, landRoutes, type LandOutcome } from "./land.js";
import { prSnapshot } from "./pr-snapshot.js";

const REPOS = ["octo/a", "octo/b", "octo/c", "octo/d", "octo/e"];
const CONTEXTS = ["validate", "dag-check"];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** `ci-wait`'s poll interval. */
const POLL_MS = 30_000;

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** One fake per repo behind one wire, as the service's one port reaches every repo. */
function multiRepoWire(fakes: Map<string, FakeGitHub>): GitHubWire {
  return new Proxy({} as GitHubWire, {
    get: (_target, method: string) => {
      return (repo: string, ...rest: unknown[]) => (fakes.get(repo)!.wire as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!(repo, ...rest);
    },
  });
}

function pendingRun(name: string, id: number): CheckRun {
  return { ...successRun(name, id), status: "in_progress", conclusion: null };
}

interface WaitingRun {
  repo: string;
  pr: number;
  headSha: string;
  /** When the head's required checks finish, staggered over 6 to 17 minutes. */
  doneAt: number;
}

/** 30 open PRs, six in each of five repos, each with required checks that run for a while and then pass. */
function waitingRuns(): { fakes: Map<string, FakeGitHub>; runs: WaitingRun[] } {
  const fakes = new Map(REPOS.map((repo) => [repo, fakeGitHub({ repo })]));
  const runs = Array.from({ length: 30 }, (_, i) => {
    const repo = REPOS[i % REPOS.length]!;
    const headSha = fakeSha(`head${i}`);
    const pr = fakes.get(repo)!.addPr({ headSha }).number;
    return { repo, pr, headSha, doneAt: (6 + (i % 12)) * MINUTE };
  });
  return { fakes, runs };
}

function setChecks(fakes: Map<string, FakeGitHub>, runs: WaitingRun[], at: number): void {
  for (const run of runs) {
    const make = at < run.doneAt ? pendingRun : successRun;
    fakes.get(run.repo)!.setRuns(run.headSha, [make("validate", 1), make("dag-check", 2)]);
  }
}

const ciInput = (run: { repo: string; pr: number }) => ({ repo: run.repo, pr: run.pr, contexts: CONTEXTS, strict: true });
const HEAD = fakeSha("settled");
const CI = ciInput({ repo: "o/r", pr: 1 });
const allCompleted = (runs: readonly CheckRun[]): boolean => runs.every((run) => run.status === "completed");

/** One PR whose snapshot has already read it green, so a later read would be served from the settled window. */
async function settledGreen() {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  let clock = 0;
  const port = githubPort(fake.wire);
  const snapshot = prSnapshot(port, { now: () => clock });
  expect((await readCi(port, CI, snapshot)).verdict).toBe("green");
  return { fake, port, snapshot, advance: (ms: number) => void (clock += ms) };
}

const restCalls = (fakes: Map<string, FakeGitHub>): number => [...fakes.values()].reduce((sum, fake) => sum + fake.calls.length, 0);

describe("PR snapshot", () => {
  it("serves 30 waiting runs in 5 repos for one simulated hour with under 600 REST calls", async () => {
    const { fakes, runs } = waitingRuns();
    let clock = 0;
    const port = githubPort(multiRepoWire(fakes));
    const snapshot = prSnapshot(port, { now: () => clock });
    const verdicts = new Map<WaitingRun, CiSnapshot>();

    // Like ci-wait, a run polls until its verdict is no longer pending; its green is confirmed through the port once.
    for (clock = 0; clock < HOUR; clock += POLL_MS) {
      setChecks(fakes, runs, clock);
      const waiting = runs.filter((run) => verdicts.get(run)?.verdict !== "green");
      const read = await Promise.all(waiting.map((run) => readCi(port, ciInput(run), snapshot)));
      waiting.forEach((run, i) => verdicts.set(run, read[i]!));
    }

    const notModified = [...fakes.values()].reduce((sum, fake) => sum + fake.notModified, 0);
    expect(restCalls(fakes)).toBeLessThan(600);
    expect(notModified).toBeGreaterThan(0);
    expect(runs.map((run) => verdicts.get(run)?.verdict)).toEqual(runs.map(() => "green"));
  });

  it("never answers green from a settled snapshot when a failed run was added on the same head", async () => {
    const { fake, port, snapshot, advance } = await settledGreen();
    fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2), successRun("validate", 3, "2026-01-01T00:05:00Z", "failure")]);
    advance(MINUTE);

    const ci = await readCi(port, CI, snapshot);

    expect(ci.verdict).toBe("red");
  });

  it("never answers green from a settled snapshot when the head fell behind under strict rules", async () => {
    const { fake, port, snapshot, advance } = await settledGreen();
    fake.pr(1).behind = true;
    advance(MINUTE);

    const ci = await readCi(port, CI, snapshot);

    expect(ci.verdict).toBe("behind");
  });

  it("keeps a head pending while a non-required Actions run is still going, and reads it again within the pending interval", async () => {
    const fake = fakeGitHub();
    fake.addPr({ headSha: HEAD });
    let clock = 0;
    const port = githubPort(fake.wire);
    const snapshot = prSnapshot(port, { now: () => clock });
    fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2), pendingRun("lint", 3)]);

    const first = await readCi(port, CI, snapshot);
    fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2), successRun("lint", 3)]);
    clock += 3 * MINUTE;
    const later = await readCi(port, CI, snapshot);

    expect(first).toMatchObject({ verdict: "pending", waitingOn: ["lint"] });
    expect(later.verdict).toBe("green");
  });

  it("revalidates an unchanged list with a 304 and reads no PR again; a pushed head is read at the next tick", async () => {
    const fake = fakeGitHub();
    const pr = fake.addPr({ headSha: fakeSha("one") });
    let clock = 0;
    const snapshot = prSnapshot(githubPort(fake.wire), { now: () => clock });

    await snapshot.getPr("o/r", pr.number);
    clock += MINUTE;
    const unchanged = await snapshot.getPr("o/r", pr.number);
    fake.pushHead(pr.number, fakeSha("two"));
    clock += MINUTE;
    const moved = await snapshot.getPr("o/r", pr.number);

    expect(unchanged.headSha).toBe(fakeSha("one"));
    expect(moved.headSha).toBe(fakeSha("two"));
    expect(fake.calls).toEqual(["revalidateOpenPrs", "getPr", "revalidateOpenPrs", "revalidateOpenPrs", "getPr"]);
    expect(fake.notModified).toBe(1);
  });

  it("reads a pending head's checks again only after the pending interval, and a settled head not at all within its window", async () => {
    const fake = fakeGitHub();
    const sha = fakeSha("one");
    let clock = 0;
    const snapshot = prSnapshot(githubPort(fake.wire), { now: () => clock, pendingMs: 3 * MINUTE });
    fake.setRuns(sha, [pendingRun("validate", 1)]);

    await snapshot.checkRuns("o/r", sha, allCompleted);
    clock += MINUTE;
    await snapshot.checkRuns("o/r", sha, allCompleted);
    fake.setRuns(sha, [successRun("validate", 1)]);
    clock += 2 * MINUTE;
    const settled = await snapshot.checkRuns("o/r", sha, allCompleted);
    clock += 10 * MINUTE;
    await snapshot.checkRuns("o/r", sha, allCompleted);

    expect(settled.map((run) => run.status)).toEqual(["completed"]);
    expect(fake.calls).toEqual(["listCheckRuns", "listCheckRuns"]);
  });

  it("reads a closed PR from GitHub every time instead of the open list", async () => {
    const fake = fakeGitHub();
    const pr = fake.addPr({ headSha: fakeSha("one"), state: "closed" });
    const snapshot = prSnapshot(githubPort(fake.wire), { now: () => 0 });

    await snapshot.getPr("o/r", pr.number);
    await snapshot.getPr("o/r", pr.number);

    expect(fake.calls).toEqual(["revalidateOpenPrs", "getPr", "getPr"]);
  });
});

const allowMerge: GatePolicy = { decide: () => ({ outcome: "allow", rule: { table: "test", rowId: "allow", version: 1 }, reason: "test allows" }) };

describe("land over the PR snapshot", () => {
  it("re-reads the PR before a merge although the snapshot is fresh, so a head that moved is not merged", async () => {
    const fake = fakeGitHub();
    const first = fakeSha("approved");
    const pushed = fakeSha("pushed");
    fake.addPr({ headSha: first });
    fake.onGetPr = (pr, reads) => {
      // Reads: land-rules, the snapshot's one detail, then the merge's own read, which finds a foreign push.
      if (reads === 3) pr.headSha = pushed;
      fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    };
    const port = githubPort(fake.wire);
    const routes = landRoutes({ port, now: () => 0, sleep: async () => undefined, snapshot: prSnapshot(port, { now: () => 0 }) });
    const outcomes: LandOutcome[] = [];
    const workflow = defineWorkflow({ name: "land-test", steps: LAND_STEPS, run: async (ctx) => void outcomes.push(await land(ctx, { repo: "o/r", pr: 1 }, { policy: allowMerge })) });
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [workflow], routes, gatePollMs: 5 });
    hosts.push(host);

    const run = await host.runtime.wait(host.runtime.start("land-test"));

    expect(run.status).toBe("completed");
    expect(outcomes.at(-1)).toMatchObject({ kind: "merged", headSha: pushed });
    expect(fake.effects.merge).toBe(1);
    expect(fake.calls.filter((call, i) => call === "merge" || fake.calls[i + 1] === "merge")).toEqual(["getPr", "merge"]);
    expect(fake.calls.filter((call) => call === "getPr")).toHaveLength(7);
  });
});
