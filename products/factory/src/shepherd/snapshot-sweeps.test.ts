import { fakeGitHub, fakeSha, githubPort, type FakeGitHub, type GitHubWire, type PullRequest } from "@titan-design/github";
import type { GhExec } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { tickPacing } from "../tick-pacing.js";
import { prSnapshot } from "../workflows/pr-snapshot.js";
import { heldCheck } from "./hold.js";
import { openOnBranch, openOrRead } from "./snapshot-reads.js";
import { VERSION_PACKAGES_BRANCH } from "./release.js";
import type { HoldLookup } from "./store.js";

const REPO = "octo/held";
const HOLD_POLL_MS = 10_000;
const TICK_MS = 60_000;
const holdsEverything: HoldLookup = { heldReason: () => "held for a reviewer" };
const calls = (fake: FakeGitHub, name: string): number => fake.calls.filter((call) => call === name).length;

function heldRuns(count: number): { fake: FakeGitHub; numbers: number[] } {
  const fake = fakeGitHub({ repo: REPO });
  const numbers = Array.from({ length: count }, (_, i) => fake.addPr({ headSha: fakeSha(`held${i}`) }).number);
  return { fake, numbers };
}

const rateLimit = (remaining: number): GhExec => async () => ({ code: 0, stdout: JSON.stringify({ resources: { core: { remaining } } }), stderr: "" });

describe("snapshot reads in the hold wait", () => {
  it("makes no per-run getPr call for 20 held runs polling for an hour, and one list read per tick", async () => {
    const { fake, numbers } = heldRuns(20);
    let clock = 0;
    const port = githubPort(fake.wire);
    const held = heldCheck(port, () => holdsEverything, undefined, undefined, prSnapshot(port, { now: () => clock }));

    for (clock = 0; clock < 60 * TICK_MS; clock += HOLD_POLL_MS) {
      const reasons = await Promise.all(numbers.map((pr) => held(REPO, pr)));
      expect(reasons).toEqual(numbers.map(() => "held for a reviewer"));
    }

    expect(calls(fake, "getPr")).toBe(0);
    expect(calls(fake, "revalidateOpenPrs")).toBeLessThanOrEqual(60);
  });

  it("releases a hold for a PR that left the open list, reading it from the port", async () => {
    const { fake, numbers } = heldRuns(2);
    let clock = 0;
    const port = githubPort(fake.wire);
    const held = heldCheck(port, () => holdsEverything, undefined, undefined, prSnapshot(port, { now: () => clock }));
    expect(await held(REPO, numbers[0]!)).toBe("held for a reviewer");

    Object.assign(fake.pr(numbers[0]!), { merged: true, state: "closed" });
    clock += TICK_MS;

    expect(await held(REPO, numbers[0]!)).toBeUndefined();
    expect(calls(fake, "getPr")).toBe(1);
  });
});

describe("snapshot reads in the release sweep", () => {
  it("finds the open Version Packages PR from the list with no findPr call, and none when it is closed", async () => {
    const fake = fakeGitHub({ repo: REPO });
    const release = fake.addPr({ headSha: fakeSha("release"), headRef: VERSION_PACKAGES_BRANCH });
    let clock = 0;
    const port = githubPort(fake.wire);
    const snapshot = prSnapshot(port, { now: () => clock });

    expect((await openOnBranch(port, snapshot, REPO, VERSION_PACKAGES_BRANCH))?.number).toBe(release.number);
    fake.pr(release.number).state = "closed";
    clock += TICK_MS;

    expect(await openOnBranch(port, snapshot, REPO, VERSION_PACKAGES_BRANCH)).toBeNull();
    expect(calls(fake, "listPrs")).toBe(0);
  });
});

/** The port as GitHub answers `findPr`: `head=<owner>:<branch>` lists that owner's heads only, so another owner's fork never matches. */
function sameOwnerHeads(fake: FakeGitHub): GitHubWire {
  const owner = (slug: string): string => slug.split("/")[0]!.toLowerCase();
  return { ...fake.wire, listPrs: async (repo, branch) => (await fake.wire.listPrs(repo, branch)).filter((pr) => owner(pr.headRepo ?? "") === owner(repo)) };
}

type Seed = (fake: FakeGitHub) => void;
const add = (fake: FakeGitHub, tag: string, fields: Partial<PullRequest> = {}): number => fake.addPr({ headSha: fakeSha(tag), headRef: VERSION_PACKAGES_BRANCH, ...fields }).number;
const openAnswer = (pr: PullRequest | null) => (pr && pr.state === "open" ? { number: pr.number, headSha: pr.headSha } : null);

describe("snapshot reads answer as the port reads they replace", () => {
  const lookups: [string, Seed][] = [
    ["a fork PR numbered above the real one", (fake) => (add(fake, "real"), add(fake, "fork", { headRepo: "fork/x" }), void 0)],
    ["only a fork PR on the branch", (fake) => void add(fake, "fork", { headRepo: "fork/x" })],
    ["a closed PR above the open one", (fake) => (add(fake, "open"), add(fake, "closed", { state: "closed" }), void 0)],
    ["only a closed PR on the branch", (fake) => void add(fake, "closed", { state: "closed", merged: true })],
    ["no PR on the branch", (fake) => void add(fake, "other", { headRef: "topic" })],
  ];

  it.each(lookups)("openOnBranch finds the same open PR with and without a snapshot: %s", async (_name, seed) => {
    const fake = fakeGitHub({ repo: REPO });
    seed(fake);
    const port = githubPort(sameOwnerHeads(fake));

    const viaPort = await openOnBranch(port, undefined, REPO, VERSION_PACKAGES_BRANCH);
    const viaSnapshot = await openOnBranch(port, prSnapshot(port), REPO, VERSION_PACKAGES_BRANCH);

    expect(openAnswer(viaSnapshot)).toEqual(openAnswer(viaPort));
  });

  it.each([
    ["an open PR on the list", (fake: FakeGitHub) => add(fake, "open")],
    ["a merged PR that left the list", (fake: FakeGitHub) => add(fake, "merged", { state: "closed", merged: true })],
    ["a closed PR that left the list", (fake: FakeGitHub) => add(fake, "closed", { state: "closed" })],
    ["a fork's open PR", (fake: FakeGitHub) => add(fake, "fork", { headRepo: "fork/x" })],
  ])("openOrRead returns the same PR with and without a snapshot: %s", async (_name, seed) => {
    const fake = fakeGitHub({ repo: REPO });
    const number = seed(fake);
    const port = githubPort(sameOwnerHeads(fake));

    const viaPort = await openOrRead(port, undefined, REPO, number);
    const viaSnapshot = await openOrRead(port, prSnapshot(port), REPO, number);

    expect(viaSnapshot).toMatchObject({ number: viaPort.number, state: viaPort.state, merged: viaPort.merged, headSha: viaPort.headSha, headRef: viaPort.headRef, baseRef: viaPort.baseRef });
  });
});

describe("tick pacing", () => {
  it("keeps the 60 s tick until the rate limit read lands, and while calls are plentiful", async () => {
    const pacing = tickPacing({ exec: rateLimit(4_000) });
    expect(pacing.tickMs()).toBe(60_000);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pacing.status()).toEqual({ tickMs: 60_000, slowed: false, remaining: 4_000 });
  });

  it("slows the tick to 5 minutes at a rate_limit of 900 and reports it", async () => {
    const pacing = tickPacing({ exec: rateLimit(900) });
    pacing.status();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pacing.status()).toEqual({ tickMs: 300_000, slowed: true, remaining: 900 });
  });

  it("slows the snapshot's list reads to one per 5 minutes while the rate limit is low", async () => {
    const { fake, numbers } = heldRuns(3);
    let clock = 0;
    const port = githubPort(fake.wire);
    const pacing = tickPacing({ exec: rateLimit(900), now: () => clock });
    pacing.status();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const held = heldCheck(port, () => holdsEverything, undefined, undefined, prSnapshot(port, { now: () => clock, tickMs: pacing.tickMs }));

    for (clock = 0; clock < 30 * 60_000; clock += HOLD_POLL_MS) await Promise.all(numbers.map((pr) => held(REPO, pr)));

    expect(calls(fake, "revalidateOpenPrs")).toBeLessThanOrEqual(6);
  });

  it("keeps the normal tick when rate_limit cannot be read", async () => {
    const pacing = tickPacing({ exec: async () => ({ code: 1, stdout: "", stderr: "offline" }) });
    pacing.status();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pacing.status()).toEqual({ tickMs: 60_000, slowed: false, remaining: null });
  });
});
