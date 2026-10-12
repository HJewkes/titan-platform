import { beforeEach, describe, expect, it } from "vitest";
import type { CleanMergeTree } from "./approved-head-walk.js";
import { fakeGitHub, fakeSha, successRun, type FakeGitHub } from "./fake.js";
import { githubPort, type PullRequest } from "./port.js";
import { formatPremerge, MERGEABILITY_RETRY_MS, premerge } from "./premerge.js";

const S = fakeSha("pr-head");
const R = fakeSha("reviewed");
const B1 = fakeSha("base-1");
const TIP = fakeSha("base-tip");

function world(pr: Partial<PullRequest> = {}): FakeGitHub {
  const fake = fakeGitHub();
  fake.rules = { contexts: ["validate"], strict: true };
  fake.addPr({ headSha: S, ...pr });
  fake.setRuns(S, [successRun("validate", 1)]);
  return fake;
}

const check = (fake: FakeGitHub, approvedHead = S, cleanMergeTree?: CleanMergeTree) => premerge(githubPort(fake.wire), { repo: "o/r", number: 1, headSha: S, approvedHead, ...(cleanMergeTree ? { cleanMergeTree } : {}) });

describe("premerge", () => {
  it("is ok for an open, green, up-to-date PR whose head was approved", async () => {
    expect(await check(world({ behindBy: 0 }))).toEqual({ repo: "o/r", number: 1, ok: true, reasons: [], head: S, base: "main", required: ["validate"], strict: true, behindBy: 0 });
  });

  it("is ok when the approved head is reached through a clean base merge", async () => {
    const fake = world();
    fake.commits.set(S, { sha: S, parents: [R, B1], tree: fakeSha("tree:S") });

    expect(await check(fake, R, async () => fakeSha("tree:S"))).toMatchObject({ ok: true, reasons: [] });
  });

  it("fails with the walk's reason when the approved head is not a parent of a base merge", async () => {
    const result = await check(world(), R, async () => fakeSha("tree:S"));

    expect(result).toMatchObject({ ok: false, reasons: [`approved ${R} but the head is ${S}: head ${S} is not a two-parent merge of reviewed ${R}`] });
  });

  it("fails naming a red required check", async () => {
    const fake = world();
    fake.setRuns(S, [successRun("validate", 1, undefined, "failure")]);

    expect(await check(fake)).toMatchObject({ ok: false, reasons: ["checks red: validate=failure"] });
  });

  it("accepts a successful commit status for an unpinned required context", async () => {
    const fake = world();
    fake.setRuns(S, []);
    fake.statuses.set(S, [{ context: "validate", state: "success" }]);

    expect(await check(fake)).toMatchObject({ ok: true });
  });

  it("fails when the head is behind and the rules are strict, reporting how far", async () => {
    const result = await check(world({ behind: true, behindBy: 3 }));

    expect(result).toMatchObject({ ok: false, behindBy: 3, reasons: ["topic-1 is behind main and the rules require it up to date"] });
  });

  it("fails for a closed PR", async () => {
    expect(await check(world({ state: "closed" }))).toMatchObject({ ok: false, reasons: ["#1 is closed"] });
  });

  it("fails when the PR head is not the sha the caller means to merge", async () => {
    const result = await premerge(githubPort(world().wire), { repo: "o/r", number: 1, headSha: R, approvedHead: R });

    expect(result.reasons[0]).toBe(`head ${S} != ${R}`);
  });
});

describe("premerge conflicts", () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  const gate = (fake: FakeGitHub, cleanMergeTree?: CleanMergeTree) => premerge(githubPort(fake.wire), { repo: "o/r", number: 1, headSha: S, approvedHead: S, sleep, ...(cleanMergeTree ? { cleanMergeTree } : {}) });

  beforeEach(() => void sleeps.splice(0));

  it("fails a PR GitHub reports as conflicting", async () => {
    expect(await gate(world({ mergeableState: "dirty" }))).toMatchObject({ ok: false, reasons: ["topic-1 conflicts with main"] });
  });

  it("re-reads unknown mergeability and fails when it resolves to a conflict", async () => {
    const fake = world({ mergeableState: "unknown" });
    fake.onGetPr = (pr, reads) => void (reads === 3 && (pr.mergeableState = "dirty"));

    expect(await gate(fake)).toMatchObject({ ok: false, reasons: ["topic-1 conflicts with main"] });
    expect(sleeps).toEqual(MERGEABILITY_RETRY_MS.slice(0, 2));
  });

  it("is ok once unknown mergeability resolves clean", async () => {
    const fake = world({ mergeableState: "unknown" });
    fake.onGetPr = (pr, reads) => void (reads === 2 && (pr.mergeableState = "clean"));

    expect(await gate(fake)).toMatchObject({ ok: true });
  });

  it("fails closed when mergeability stays unknown after every re-read", async () => {
    expect(await gate(world({ mergeableState: "unknown" }))).toMatchObject({ ok: false, reasons: ["GitHub has not computed mergeability of topic-1, so a conflict cannot be ruled out"] });
    expect(sleeps).toEqual([...MERGEABILITY_RETRY_MS]);
  });

  it("with a clone, merges the head into the base tip GitHub reports instead of waiting on GitHub", async () => {
    const asked: [string, string][] = [];
    const fake = world({ mergeableState: "unknown" });
    fake.refs.set("main", TIP);
    const result = await gate(fake, async (base, head) => (asked.push([base, head]), fakeSha("tree")));

    expect(result).toMatchObject({ ok: true });
    expect(asked).toEqual([[TIP, S]]);
    expect(sleeps).toEqual([]);
  });

  it("with a clone, fails a head that conflicts with the base tip while GitHub's mergeability is unknown", async () => {
    const fake = world({ mergeableState: "unknown" });
    fake.refs.set("main", TIP);

    expect(await gate(fake, async () => null)).toMatchObject({ ok: false, reasons: [`merge-tree conflict vs main tip ${TIP}`] });
  });

  it("with a clone, fails when GitHub reports no tip for the base branch", async () => {
    const fake = world();
    fake.refs.delete("main");

    expect(await gate(fake, async () => fakeSha("tree"))).toMatchObject({ ok: false, reasons: ["base branch main has no tip on GitHub, so a conflict cannot be ruled out"] });
  });

  it("with a clone, fails when the merge-tree cannot be computed", async () => {
    const fake = world();
    fake.refs.set("main", TIP);
    const result = await gate(fake, async () => Promise.reject(new Error("git merge-tree exited 1: not something we can merge")));

    expect(result).toMatchObject({ ok: false, reasons: [`merge-tree of ${S} and main tip ${TIP} failed: git merge-tree exited 1: not something we can merge`] });
  });

  it("with a clone, still fails a PR GitHub reports as conflicting", async () => {
    expect(await gate(world({ mergeableState: "dirty" }), async () => fakeSha("tree"))).toMatchObject({ ok: false, reasons: ["topic-1 conflicts with main"] });
  });
});

describe("formatPremerge", () => {
  const base = { repo: "o/r", number: 7, head: S, base: "main", required: ["a", "b"], strict: true, behindBy: 0 };

  it("prints the OK line", () => {
    expect(formatPremerge({ ...base, ok: true, reasons: [] })).toBe(`OK o/r#7 head=${S} base=main req=[a,b] strict=true behind=0`);
  });

  it("prints every reason on the FAIL line", () => {
    expect(formatPremerge({ ...base, ok: false, reasons: ["#7 is closed", "checks red: a=failure"] })).toBe("FAIL o/r#7: #7 is closed; checks red: a=failure");
  });
});
