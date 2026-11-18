import { FakeHttpError, fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { MainCiReads } from "./main-ci-reads.js";

const REPO = "acme/widgets";
const T0 = Date.parse("2026-09-20T10:00:00Z");
const merge = (pr: number): string => fakeSha(`merge-${pr}`);

interface World {
  fake: FakeGitHub;
  clock: { now: number };
}

function world(): World {
  return { fake: fakeGitHub({ repo: REPO }), clock: { now: T0 } };
}

describe("MainCiReads", () => {
  const SHA = merge(1);

  function reads(w: World, freshMs = 30_000) {
    w.fake.setRuns(SHA, [successRun("validate", 1)]);
    return new MainCiReads(githubPort(w.fake.wire), () => w.clock.now, freshMs);
  }

  const checkReads = (w: World): number => w.fake.calls.filter((call) => call === "listCheckRuns").length;

  it("answers every reader of one repo and sha from one read within the poll window", async () => {
    const w = world();
    const shared = reads(w);

    await Promise.all([shared.checkRuns(REPO, SHA), shared.checkRuns(REPO, SHA), shared.checkRuns(REPO.toUpperCase(), SHA)]);
    w.clock.now += 29_999;
    const late = await shared.checkRuns(REPO, SHA);

    expect(checkReads(w)).toBe(1);
    expect(late.map((run) => run.name)).toEqual(["validate"]);
  });

  it("reads again once the window has passed", async () => {
    const w = world();
    const shared = reads(w);

    await shared.checkRuns(REPO, SHA);
    w.clock.now += 30_000;
    await shared.checkRuns(REPO, SHA);

    expect(checkReads(w)).toBe(2);
  });

  it("reads each sha of a repo apart", async () => {
    const w = world();
    const shared = reads(w);

    await Promise.all([shared.checkRuns(REPO, SHA), shared.checkRuns(REPO, merge(2))]);

    expect(checkReads(w)).toBe(2);
  });

  it("keeps no failed read, so the next poll reads again", async () => {
    const w = world();
    const shared = reads(w);
    w.fake.readFaults.listCheckRuns = [new FakeHttpError(502, "bad gateway")];

    await expect(shared.checkRuns(REPO, SHA)).rejects.toThrow();
    const again = await shared.checkRuns(REPO, SHA);

    expect(again).toHaveLength(1);
    expect(checkReads(w)).toBe(2);
  });

  it("hands each reader its own list, so one reader's change reaches no other", async () => {
    const w = world();
    const shared = reads(w);

    const first = await shared.checkRuns(REPO, SHA);
    first.pop();

    expect(await shared.checkRuns(REPO, SHA)).toHaveLength(1);
  });
});
