import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type PrFile } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidenceInput } from "./merge-facts.js";
import type { VisualBaselines } from "./visual-gate.js";

const HEAD = fakeSha("visual-baseline-head");
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const locator = partialFake<SourceTextLocator>({ selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] } });
const BEAT = "packages/ui/src/components/ui/motion/Beat.tsx";
const SPECIMEN_PNG = "packages/ui/specimen/baseline/button/default-chromium-linux.png";
const STORY_PNG = "packages/ui/tests/visual/reference/stories.spec.ts-snapshots/x.png";
const BASELINES: VisualBaselines = { check: "visual", paths: ["packages/ui/specimen/baseline/**", "packages/ui/tests/visual/reference/**-snapshots/**"] };

const input: MergeEvidenceInput = {
  runId: "run-1",
  repo: "octo/design",
  pr: 1,
  head: HEAD,
  verdict: { value: "MERGE", head: HEAD, locator },
  resolver: REVIEWER,
  dispatchedReviewer: REVIEWER,
  seatGrants: ["merge-on-green-approve"],
  visualPaths: ["packages/ui/src/components/**"],
};

const green = successRun("visual", 3);

async function decisionFor(files: PrFile[], { runs = [green], baselines = BASELINES }: { runs?: CheckRun[]; baselines?: VisualBaselines | null } = {}) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2), ...runs]);
  fake.prFiles.set(1, files);
  const evidence = await mergeEvidence(githubPort(fake.wire), { ...input, ...(baselines && { visualBaselines: baselines }) }, null, noFreezeStoreUntilTp523, { kind: "feature" });
  return evidence.record.decision;
}

const modified = (path: string): PrFile => ({ path, status: "modified" });

describe("a visual head gates only on a changed baseline once the seat names its baseline check", () => {
  it("merges a rendering change with no baseline change when the visual check passed at the head, naming the clearance", async () => {
    const decision = await decisionFor([modified(BEAT)]);

    expect(decision).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RV" } });
    expect(decision.reason).toContain("changed no baseline");
    expect(decision.reason).toContain(BEAT);
  });

  it("gates a changed specimen baseline, naming the baseline file rather than the component", async () => {
    const decision = await decisionFor([modified("packages/ui/src/components/Button.tsx"), modified(SPECIMEN_PNG)]);

    expect(decision).toMatchObject({ outcome: "gate", rule: { table: "shepherd-merge-guard", rowId: "visual-path" } });
    expect(decision.reason).toContain(SPECIMEN_PNG);
    expect(decision.reason).not.toContain("Button.tsx");
  });

  it.each(["added", "removed"])("gates a story snapshot that is %s, though its directory is named like a spec", async (status) => {
    const decision = await decisionFor([modified(BEAT), { path: STORY_PNG, status }]);

    expect(decision).toMatchObject({ outcome: "gate", rule: { rowId: "visual-path" } });
    expect(decision.reason).toContain(STORY_PNG);
  });

  const notGreen: [string, CheckRun[]][] = [
    ["failed", [successRun("visual", 3, undefined, "failure")]],
    ["skipped", [successRun("visual", 3, undefined, "skipped")]],
    ["neutral", [successRun("visual", 3, undefined, "neutral")]],
    ["pending", [{ ...green, status: "in_progress", conclusion: null }]],
    ["posted by another app", [successRun("visual", 3, undefined, "success", 4242)]],
    ["at another head", [successRun("visual", 3, undefined, "success", undefined, fakeSha("other-head"))]],
    ["missing", []],
  ];

  it.each(notGreen)("keeps the glob gate when the visual check is %s", async (_state, runs) => {
    const decision = await decisionFor([modified(BEAT)], { runs });

    expect(decision).toMatchObject({ outcome: "gate", rule: { rowId: "visual-path" }, reason: expect.stringContaining(BEAT) });
  });

  it("keeps the glob gate when the seat names no baselines, even with the visual check green", async () => {
    const decision = await decisionFor([modified(BEAT)], { baselines: null });

    expect(decision).toMatchObject({ outcome: "gate", rule: { rowId: "visual-path" }, reason: expect.stringContaining(BEAT) });
  });

  it.each<[string, VisualBaselines]>([
    ["an empty baseline list", { check: "visual", paths: [] }],
    ["a baseline list of one empty glob", { check: "visual", paths: [""] }],
    ["a baseline list of one blank glob", { check: "visual", paths: [" "] }],
    ["a blank check name", { check: " ", paths: BASELINES.paths }],
  ])("keeps the glob gate when the seat names %s", async (_case, baselines) => {
    const decision = await decisionFor([modified(BEAT)], { baselines });

    expect(decision).toMatchObject({ outcome: "gate", rule: { rowId: "visual-path" }, reason: expect.stringContaining(BEAT) });
  });

  it("gates a baseline written in another case, as a case-insensitive checkout writes it", async () => {
    const upper = "Packages/UI/Specimen/Baseline/button/default-chromium-linux.png";
    const decision = await decisionFor([modified(BEAT), modified(upper)]);

    expect(decision).toMatchObject({ outcome: "gate", rule: { rowId: "visual-path" } });
    expect(decision.reason).toContain(upper);
  });

  it("does not consult baselines for a head that matches no visual glob", async () => {
    const decision = await decisionFor([modified("packages/core/src/index.ts")], { runs: [] });

    expect(decision).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RV" } });
    expect(decision.reason).not.toContain("baseline");
  });
});
