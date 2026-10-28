import { fakeGitHub, fakeSha, githubPort, successRun, type PrFile } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { decideAutoMerge, mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidence, type MergeEvidenceInput } from "./merge-facts.js";
import type { VisualDelta } from "./visual-delta-read.js";
import type { VisualBaselines } from "./visual-gate.js";

const HEAD = fakeSha("visual-threshold-head");
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const BUTTON = "packages/ui/src/components/Button.tsx";
const SHOT = "packages/ui/tests/visual/reference/stories.spec.ts-snapshots/card--default-chromium-linux.png";
const API_REPORT = "packages/ui/api/index.api.md";
const BASELINES: VisualBaselines = { check: "visual", paths: ["packages/ui/specimen/baseline/**", "packages/ui/tests/visual/reference/**-snapshots/**"] };
const VISUAL_PATHS = ["packages/ui/**"];
const COMPONENT_PATHS = ["packages/ui/src/**"];

const input: MergeEvidenceInput = {
  runId: "run-1",
  repo: "octo/design",
  pr: 1,
  head: HEAD,
  verdict: { value: "MERGE", head: HEAD, locator: partialFake<SourceTextLocator>() },
  resolver: REVIEWER,
  dispatchedReviewer: REVIEWER,
  seatGrants: ["merge-on-green-approve"],
};

/** A reviewed MERGE at HEAD with every check green, the seat's `visual` check included; only the files vary. */
async function evidenceFor(files: PrFile[]): Promise<MergeEvidence> {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2), successRun("visual", 3)]);
  fake.prFiles.set(1, files);
  return mergeEvidence(githubPort(fake.wire), input, noFreezeStoreUntilTp523, { kind: "feature" });
}

type Shot = VisualDelta["snapshots"][number];

function delta(mode: VisualDelta["policy"]["mode"], more: Partial<VisualDelta> = {}): VisualDelta {
  return { policy: { mode, maxChangedShare: 0.01, pixelTolerance: 0.1 }, mergeBase: fakeSha("merge-base"), snapshots: [], api: [], tokens: [], harness: [], ...more };
}

const changedShot = (share: number): Shot => ({ path: SHOT, component: "card", status: "changed", share });
const modified = (path: string): PrFile => ({ path, status: "modified" });
const SHOT_CHANGE = [modified(BUTTON), modified(SHOT)];

async function decide(files: PrFile[], visualDelta: VisualDelta | undefined, visualPaths: string[] = VISUAL_PATHS) {
  const evidence = await evidenceFor(files);
  return decideAutoMerge(HEAD, { ...evidence, ...(visualDelta && { visualDelta }) }, visualPaths, BASELINES);
}

const VISUAL_GATE = { outcome: "gate", rule: { table: "shepherd-merge-guard", rowId: "visual-path", version: 1 } };

describe("the merge decision under visual threshold mode on", () => {
  it.each([
    ["below", 0.004, "max 0.4% (≤ 1.0%)"],
    ["exactly at", 0.01, "max 1.0% (≤ 1.0%)"],
  ])("merges a snapshot measured %s the threshold with the visual check green, saying what it measured", async (_case, share, shown) => {
    const decision = await decide(SHOT_CHANGE, delta("on", { snapshots: [changedShot(share)] }));

    expect(decision).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RV" } });
    expect(decision.reason).toContain(`changed 1 snapshot, ${shown}, no public API, token or harness change, and visual passed at ${HEAD}`);
  });

  it("gates a snapshot above the threshold, naming its component and share", async () => {
    const decision = await decide(SHOT_CHANGE, delta("on", { snapshots: [changedShot(0.042)] }));

    expect(decision).toMatchObject(VISUAL_GATE);
    expect(decision.reason).toContain(`card ${SHOT} changed 4.2% (over 1.0%)`);
  });

  it.each([
    ["public API", { api: [API_REPORT] }, API_REPORT],
    ["token", { tokens: ["packages/ui/src/theme/config.ts"] }, "packages/ui/src/theme/config.ts"],
    ["visual harness", { harness: ["packages/ui/playwright.config.ts"] }, "packages/ui/playwright.config.ts"],
  ])("gates a %s change that no seat glob matches", async (kind, lists, path) => {
    const decision = await decide([modified(path)], delta("on", lists), ["packages/ui/src/components/**"]);

    expect(decision).toMatchObject(VISUAL_GATE);
    expect(decision.reason).toBe(`the owner decides visual changes: ${path} (${kind})`);
  });

  it("gates a removed snapshot, even where the seat's globs do not match it", async () => {
    const decision = await decide([{ path: SHOT, status: "removed" }], delta("on", { snapshots: [{ path: SHOT, component: "card", status: "removed" }] }), COMPONENT_PATHS);

    expect(decision).toMatchObject(VISUAL_GATE);
    expect(decision.reason).toContain(`${SHOT} removed`);
  });

  it("gates an unmeasured snapshot, naming why it could not be measured", async () => {
    const unmeasured: Shot = { path: SHOT, component: "card", status: "unmeasured", reason: "unsupported PNG format" };
    const decision = await decide(SHOT_CHANGE, delta("on", { snapshots: [unmeasured] }), COMPONENT_PATHS);

    expect(decision).toMatchObject(VISUAL_GATE);
    expect(decision.reason).toContain(`${SHOT} unmeasured: unsupported PNG format`);
  });

  it("gates a changed baseline that is not a measured snapshot, and a delta that fails the schema", async () => {
    const snap = "packages/ui/specimen/baseline/__snapshots__/button.snap";
    const notMeasured = await decide([modified(BUTTON), modified(snap)], delta("on"));
    const malformed = await decide([modified(BUTTON)], partialFake<VisualDelta>({ policy: delta("on").policy, mergeBase: null }));

    expect(notMeasured).toMatchObject({ ...VISUAL_GATE, reason: `the owner decides visual changes: ${snap}` });
    expect(malformed).toMatchObject({ ...VISUAL_GATE, reason: expect.stringContaining("malformed") });
  });
});

describe("the merge decision without visual threshold mode on", () => {
  it.each([0.004, 0.042])("keeps today's decision under shadow for a snapshot measured at %s", async (share) => {
    const today = await decide(SHOT_CHANGE, undefined);
    const shadow = await decide(SHOT_CHANGE, delta("shadow", { snapshots: [changedShot(share)], api: [API_REPORT] }));

    expect(shadow).toEqual(today);
  });

  it("keeps today's decision with no visual delta: a changed baseline gates, naming the file", async () => {
    const evidence = await evidenceFor(SHOT_CHANGE);

    expect(decideAutoMerge(HEAD, evidence, VISUAL_PATHS, BASELINES)).toEqual({ ...VISUAL_GATE, reason: `the owner decides visual changes: ${SHOT}` });
  });
});
