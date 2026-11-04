import { describe, expect, it } from "vitest";
import { approvedHeadWalk, type ApprovedHeadWalk, type CleanMergeTree } from "./approved-head-walk.js";
import { fakeGitHub, fakeSha, successRun as anyShaRun, type FakeGitHub } from "./fake.js";
import { githubPort, type PullRequest, type RequiredChecks } from "./port.js";
import { GITHUB_ACTIONS_APP_ID, headCheckFindings, mergeReadiness, type MergeReadinessInput } from "./readiness.js";

const HEAD = fakeSha("head");
const OLD = fakeSha("old");
const pr: PullRequest = { number: 4, state: "open", merged: false, mergeSha: null, mergedAt: null, headRef: "topic", headSha: HEAD, headRepo: "o/r", baseRef: "main", draft: false, mergeableState: "clean", behind: false, autoMerge: false };
const rules: RequiredChecks = { contexts: ["check"], strict: true };

/** A run at the PR head unless `headSha` says otherwise. */
const successRun = (name: string, id: number, startedAt?: string, conclusion?: string, appId?: number, headSha = HEAD) => anyShaRun(name, id, startedAt, conclusion, appId, headSha);

function input(overrides: Partial<MergeReadinessInput> = {}): MergeReadinessInput {
  return { pr, rules, runs: [successRun("check", 1)], requiredApps: [GITHUB_ACTIONS_APP_ID], approvedHead: HEAD, ...overrides };
}

describe("mergeReadiness", () => {
  it("is ready with a green required check from an allowed app at the approved head", () => {
    expect(mergeReadiness(input())).toEqual({ ready: true, blockers: [] });
  });

  it("does not count a success from another app toward a required context", () => {
    const result = mergeReadiness(input({ runs: [successRun("check", 1, undefined, "success", 999)] }));

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([{ reason: "check-pending", detail: `check has no completed run at ${HEAD} from app ${GITHUB_ACTIONS_APP_ID}` }]);
  });

  it("ignores a newer run from another app when the allowed app's run is red", () => {
    const runs = [successRun("check", 1, "2026-01-01T00:00:00Z", "failure"), successRun("check", 2, "2026-01-02T00:00:00Z", "success", 999)];

    expect(mergeReadiness(input({ runs })).blockers.map((blocker) => blocker.reason)).toEqual(["check-failed"]);
  });

  it("refuses when the approval names a head other than the PR's current head", () => {
    const result = mergeReadiness(input({ approvedHead: OLD }));

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([{ reason: "head-moved", detail: `approved ${OLD} but the head is ${HEAD}` }]);
  });

  it("refuses with no approval at all", () => {
    expect(mergeReadiness(input({ approvedHead: null })).blockers.map((blocker) => blocker.reason)).toEqual(["unapproved"]);
  });

  it("blocks on a red optional run from an allowed app", () => {
    const runs = [successRun("check", 1), successRun("lint", 2, undefined, "failure")];

    expect(mergeReadiness(input({ runs })).blockers).toMatchObject([{ reason: "check-failed", detail: expect.stringContaining("lint concluded failure") }]);
  });

  it.each([
    ["in_progress", null],
    ["queued", null],
    ["completed", null],
  ])("blocks on an optional run from an allowed app that is %s with conclusion %s", (status, conclusion) => {
    const runs = [successRun("check", 1), { ...successRun("lint", 2), status, conclusion }];

    const result = mergeReadiness(input({ runs }));

    expect(result.ready).toBe(false);
    expect(result.blockers).toMatchObject([{ reason: status === "completed" ? "check-failed" : "check-pending", detail: expect.stringContaining("lint") }]);
  });

  it("treats a required context whose only green run is at another sha as missing", () => {
    const result = mergeReadiness(input({ runs: [successRun("check", 1, undefined, "success", undefined, OLD)] }));

    expect(result.blockers).toEqual([{ reason: "check-pending", detail: `check has no completed run at ${HEAD} from app ${GITHUB_ACTIONS_APP_ID}` }]);
  });

  it("ignores allowed-app runs at another sha, even newer or red ones", () => {
    const runs = [successRun("check", 1), successRun("check", 2, "2026-02-01T00:00:00Z", "failure", undefined, OLD), successRun("lint", 3, undefined, "failure", undefined, OLD)];

    expect(mergeReadiness(input({ runs }))).toEqual({ ready: true, blockers: [] });
  });

  it("refuses when the rules name no required context, even with no runs", () => {
    const result = mergeReadiness(input({ rules: { contexts: [], strict: true }, runs: [] }));

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([{ reason: "no-required-checks", detail: "the rules name no required check context, so nothing proves the head green" }]);
  });

  it("blocks on an older red run of a required context even when a newer run of the same name is green", () => {
    const runs = [successRun("check", 1, "2026-01-01T00:00:00Z", "failure"), successRun("check", 2, "2026-01-02T00:00:00Z")];

    expect(mergeReadiness(input({ runs })).blockers).toMatchObject([{ reason: "check-failed", detail: expect.stringContaining("check concluded failure") }]);
  });

  it("blocks on a superseded cancelled run at the head", () => {
    const runs = [successRun("check", 1, "2026-01-01T00:00:00Z", "cancelled"), successRun("check", 2, "2026-01-02T00:00:00Z")];

    expect(mergeReadiness(input({ runs })).ready).toBe(false);
  });

  it.each(["neutral", "skipped"])("refuses a required context whose only run concluded %s", (conclusion) => {
    const result = mergeReadiness(input({ runs: [successRun("check", 1, undefined, conclusion)] }));

    expect(result.ready).toBe(false);
    expect(result.blockers).toMatchObject([{ reason: "check-failed", detail: expect.stringContaining(`check concluded ${conclusion}`) }]);
  });

  it.each(["neutral", "skipped"])("lets an optional run that concluded %s through", (conclusion) => {
    const runs = [successRun("check", 1), successRun("lint", 2, undefined, conclusion)];

    expect(mergeReadiness(input({ runs }))).toEqual({ ready: true, blockers: [] });
  });

  it("holds an optional run that reports success before it has completed", () => {
    const runs = [successRun("check", 1), { ...successRun("lint", 2), status: "in_progress", completedAt: null }];

    expect(mergeReadiness(input({ runs })).blockers).toMatchObject([{ reason: "check-pending", detail: expect.stringContaining("lint is in_progress") }]);
  });

  it("holds a required context whose run reports success before it has completed", () => {
    const runs = [{ ...successRun("check", 1), status: "in_progress", completedAt: null }];

    expect(mergeReadiness(input({ runs })).blockers.map((blocker) => blocker.reason)).toEqual(["check-pending"]);
  });

  it.each([
    [{ draft: true }, "draft"],
    [{ behind: true }, "behind"],
    [{ mergeableState: "dirty" }, "conflict"],
    [{ mergeableState: "unknown" }, "mergeability-unknown"],
    [{ state: "closed" as const }, "closed"],
    [{ state: "closed" as const, merged: true }, "merged"],
  ])("gives a reason for every not-ready PR state: %o", (fields, reason) => {
    const result = mergeReadiness(input({ pr: { ...pr, ...fields } }));

    expect(result.ready).toBe(false);
    expect(result.blockers.map((blocker) => blocker.reason)).toEqual([reason]);
    expect(result.blockers.every((blocker) => blocker.detail.length > 0)).toBe(true);
  });

  it("lets a behind head through when the rules do not require it up to date", () => {
    expect(mergeReadiness(input({ pr: { ...pr, behind: true }, rules: { ...rules, strict: false } })).ready).toBe(true);
  });
});

describe("headCheckFindings", () => {
  it("names the missing context, the running run and the red run, and nothing for a green head", () => {
    const running = { ...successRun("lint", 2), status: "in_progress", conclusion: null };
    const red = successRun("test", 3, undefined, "failure");
    const findings = headCheckFindings({ headSha: HEAD, contexts: ["check", "build"], runs: [successRun("check", 1), running, red], requiredApps: [GITHUB_ACTIONS_APP_ID] });

    expect(findings).toEqual([{ kind: "missing", name: "build" }, { kind: "pending", run: running }, { kind: "failed", run: red }]);
    expect(headCheckFindings({ headSha: HEAD, contexts: ["check"], runs: [successRun("check", 1)], requiredApps: [GITHUB_ACTIONS_APP_ID] })).toEqual([]);
  });
});

describe("mergeReadiness with an approved-head walk", () => {
  const BASE_PARENT = fakeSha("base-parent");

  it("lets an approval of an earlier head stand when the walk from the PR head reached it", () => {
    const approvalWalk: ApprovedHeadWalk = { headSha: HEAD, approvedHead: OLD, ok: true, baseParents: [BASE_PARENT] };

    expect(mergeReadiness(input({ approvedHead: OLD, approvalWalk }))).toEqual({ ready: true, blockers: [] });
  });

  it("reports the walk's reason as head-moved when the walk failed", () => {
    const approvalWalk: ApprovedHeadWalk = { headSha: HEAD, approvedHead: OLD, ok: false, reasons: [`head ${HEAD} is not a two-parent merge of reviewed ${OLD}`] };

    expect(mergeReadiness(input({ approvedHead: OLD, approvalWalk })).blockers).toEqual([{ reason: "head-moved", detail: `approved ${OLD} but the head is ${HEAD}: head ${HEAD} is not a two-parent merge of reviewed ${OLD}` }]);
  });

  it("ignores an ok walk that started from a head other than the PR's", () => {
    const approvalWalk: ApprovedHeadWalk = { headSha: fakeSha("elsewhere"), approvedHead: OLD, ok: true, baseParents: [BASE_PARENT] };

    expect(mergeReadiness(input({ approvedHead: OLD, approvalWalk })).blockers.map((blocker) => blocker.reason)).toEqual(["head-moved"]);
  });
});

describe("approvedHeadWalk", () => {
  const R = fakeSha("reviewed");
  const S = fakeSha("pr-head");
  const B1 = fakeSha("base-1");
  const B2 = fakeSha("base-2");
  const M1 = fakeSha("merge-1");

  function world(commits: Record<string, string[]>): FakeGitHub {
    const fake = fakeGitHub();
    for (const [sha, parents] of Object.entries(commits)) fake.commits.set(sha, { sha, parents, tree: treeOf(sha) });
    return fake;
  }

  /** Records that `sha` is not inside `target`: their merge base is some other commit. */
  function notInside(fake: FakeGitHub, sha: string, target: string): void {
    fake.compares.set(`${sha}...${target}`, { mergeBaseSha: fakeSha(`below:${sha}`), files: [] });
  }

  const treeOf = (sha: string) => fakeSha(`tree:${sha}`);
  /** A clean merge of any base parent into R gives exactly S's tree: the merges changed no PR content. */
  const honestMerge: CleanMergeTree = async () => treeOf(S);

  const walk = (fake: FakeGitHub, options: { maxBaseMerges?: number; cleanMergeTree?: CleanMergeTree } = { cleanMergeTree: honestMerge }) =>
    approvedHeadWalk(githubPort(fake.wire), "o/r", { headSha: S, approvedHead: R, baseRef: "main", ...options });

  it("is ok without reading anything when the heads are equal", async () => {
    const fake = world({});

    expect(await approvedHeadWalk(githubPort(fake.wire), "o/r", { headSha: R, approvedHead: R, baseRef: "main" })).toEqual({ headSha: R, approvedHead: R, ok: true, baseParents: [] });
    expect(fake.calls).toEqual([]);
  });

  it("accepts one merge of the base branch into the approved head", async () => {
    expect(await walk(world({ [S]: [R, B1] }))).toEqual({ headSha: S, approvedHead: R, ok: true, baseParents: [B1] });
  });

  it("accepts two base merges whose base parents are in order", async () => {
    expect(await walk(world({ [S]: [M1, B2], [M1]: [R, B1] }))).toEqual({ headSha: S, approvedHead: R, ok: true, baseParents: [B2, B1] });
  });

  it("refuses two base merges when the earlier base parent is not in the newest", async () => {
    const fake = world({ [S]: [M1, B2], [M1]: [R, B1] });
    notInside(fake, B1, B2);

    expect(await walk(fake)).toMatchObject({ ok: false, reasons: [`earlier merged parent ${B1} is not in newest merged parent ${B2}`] });
  });

  it("refuses a head that is not a merge at all", async () => {
    expect(await walk(world({ [S]: [R] }))).toMatchObject({ ok: false, reasons: [`head ${S} is not a two-parent merge of reviewed ${R}`] });
  });

  it("refuses a first-parent chain that reaches a non-merge before the approved head", async () => {
    const C = fakeSha("plain-commit");

    expect(await walk(world({ [S]: [M1, B2], [M1]: [C, B1], [C]: [R] }))).toMatchObject({ ok: false, reasons: [`first-parent chain from ${S} reaches non-merge ${C} before reviewed ${R}`] });
  });

  it("refuses a merge whose other parent is off the base branch", async () => {
    const fake = world({ [S]: [R, B1] });
    notInside(fake, B1, "main");

    expect(await walk(fake)).toMatchObject({ ok: false, reasons: [`merged parent ${B1} is not in main`] });
  });

  it("refuses a head more base merges past the approved head than the cap", async () => {
    const M2 = fakeSha("merge-2");

    expect(await walk(world({ [S]: [M2, B2], [M2]: [M1, B1], [M1]: [R, fakeSha("base-0")] }), { maxBaseMerges: 2, cleanMergeTree: honestMerge })).toMatchObject({ ok: false, reasons: [`head ${S} is more than 2 base merges past reviewed ${R}`] });
  });

  it("refuses an evil merge whose tree differs from a clean merge of the base parent into the approved head", async () => {
    const editedInMerge: CleanMergeTree = async () => fakeSha("tree:clean-merge");

    expect(await walk(world({ [S]: [R, B1] }), { cleanMergeTree: editedInMerge })).toMatchObject({ ok: false, reasons: [`head ${S} differs from reviewed ${R} plus a base merge`] });
  });

  it("asks for the clean merge of the newest base parent and the approved head", async () => {
    const asked: [string, string][] = [];
    const recording: CleanMergeTree = async (baseParent, reviewed) => (asked.push([baseParent, reviewed]), treeOf(S));

    await walk(world({ [S]: [M1, B2], [M1]: [R, B1] }), { cleanMergeTree: recording });

    expect(asked).toEqual([[B2, R]]);
  });

  it("refuses when the approved head conflicts with the newest base parent", async () => {
    expect(await walk(world({ [S]: [R, B1] }), { cleanMergeTree: async () => null })).toMatchObject({ ok: false, reasons: [`reviewed ${R} conflicts with merged parent ${B1}`] });
  });

  it("fails closed when no merge-tree proof is supplied", async () => {
    expect(await walk(world({ [S]: [R, B1] }), {})).toMatchObject({ ok: false, reasons: [`no merge-tree proof that head ${S} is reviewed ${R} plus a base merge`] });
  });

  it("fails closed when the merge-tree proof cannot be computed", async () => {
    const unavailable: CleanMergeTree = async () => Promise.reject(new Error("git exited 128"));

    expect(await walk(world({ [S]: [R, B1] }), { cleanMergeTree: unavailable })).toMatchObject({ ok: false, reasons: [`merge-tree of reviewed ${R} and merged parent ${B1} failed: git exited 128`] });
  });

  it("refuses an octopus merge of the approved head", async () => {
    expect(await walk(world({ [S]: [R, B1, B2] }))).toMatchObject({ ok: false, reasons: [`head ${S} is not a two-parent merge of reviewed ${R}`] });
  });
});
