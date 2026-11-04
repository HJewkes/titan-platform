import { GITHUB_ACTIONS_APP_ID, fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type PrFile } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { decideAutoMerge, mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidence, type MergeEvidenceInput } from "./merge-facts.js";

const HEAD = fakeSha("visual-tier-head");
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const VISUAL_PATHS = ["packages/ui/**"];
const STORY = "packages/ui/src/button/button.stories.tsx";
const HOOK = "packages/ui/src/hooks/use-id.ts";
const COMPONENT = "packages/ui/src/button/button.tsx";

const input: MergeEvidenceInput = {
  runId: "run-1",
  repo: "octo/design",
  pr: 1,
  head: HEAD,
  verdict: { value: "MERGE", head: HEAD, locator: partialFake<SourceTextLocator>() },
  resolver: REVIEWER,
  dispatchedReviewer: REVIEWER,
  seatGrants: ["merge-on-green-approve"],
  visualPaths: VISUAL_PATHS,
};

const tierConfig = (mode: string) => ({
  mode,
  harnessPaths: ["**/playwright*.config.*", "packages/ui/scripts/**"],
  renderingPaths: ["packages/ui/src/tokens/**", "**/*.css"],
  storyPaths: ["packages/ui/src/**/*.stories.tsx"],
  logicPaths: ["packages/ui/src/**"],
  testArtifactPaths: ["packages/ui/contrast-baseline.json"],
  storyDiff: { check: "visual", paths: ["**/__snapshots__/**", "**/*-snapshots/**"], allowedApps: [GITHUB_ACTIONS_APP_ID] },
});

const GREEN: CheckRun[] = [successRun("validate", 1), successRun("dag-check", 3), successRun("visual", 2)];
const modified = (path: string): PrFile => ({ path, status: "modified" });

/** A reviewed MERGE at HEAD under the given raw tier entry, decided again from its JSON round trip as the land step reads it. */
async function evidenceFor(paths: string[], tier: unknown, runs: CheckRun[] = GREEN): Promise<MergeEvidence> {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
  fake.setRuns(HEAD, runs);
  fake.prFiles.set(1, paths.map(modified));
  const evidence = await mergeEvidence(githubPort(fake.wire), input, noFreezeStoreUntilTp523, { kind: "feature" }, undefined, { tier });
  return JSON.parse(JSON.stringify(evidence)) as MergeEvidence;
}

const decide = (evidence: MergeEvidence) => decideAutoMerge(HEAD, evidence, VISUAL_PATHS);
const VISUAL_ROW = { outcome: "gate", rule: { table: "shepherd-merge-guard", rowId: "visual-path", version: 1 } };

describe("the visual tier at the merge guard (TP-4761 S2)", () => {
  it("tier-1 non-rendering head merges under mode on", async () => {
    const evidence = await evidenceFor([STORY, HOOK], tierConfig("on"));

    const decision = decide(evidence);

    expect(decision).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RV" } });
    expect(decision.reason).toContain(`; visual files ${STORY}, ${HOOK} tier 1 (non-rendering)`);
    expect(evidence.record.visualTier).toEqual({ mode: "on", verdict: { tier: 1, basis: "non-rendering" } });
    expect(evidence.record.decision.outcome).toBe("allow");
  });

  it("shadow records tier 1 and still gates visual-path", async () => {
    const evidence = await evidenceFor([STORY, HOOK], tierConfig("shadow"));

    expect(decide(evidence)).toMatchObject(VISUAL_ROW);
    expect(evidence.record.visualTier).toEqual({ mode: "shadow", verdict: { tier: 1, basis: "non-rendering" } });
  });

  it("a tier-2 gate keeps row visual-path so the round sweep can answer it", async () => {
    const decision = decide(await evidenceFor([COMPONENT], tierConfig("on")));

    expect(decision).toMatchObject(VISUAL_ROW);
    expect(decision.reason).toMatch(/^the owner decides visual changes: packages\/ui\/src\/button\/button\.tsx; tier 2: no pixel proof: no pr-visual artifact read$/);
  });

  it("a stored record with a malformed visualTier gates as tier 2", async () => {
    const evidence = await evidenceFor([STORY, HOOK], tierConfig("on"));
    const tampered = { ...evidence, visualTier: { mode: "on", verdict: { tier: 1, basis: "looked-fine" } } };

    const decision = decide(tampered);

    expect(decision).toMatchObject(VISUAL_ROW);
    expect(decision.reason).toContain("tier 2: the recorded visual tier is malformed");
  });

  it("a harness path outside the visual globs makes a story-only head tier 2, as the tier sees every changed path", async () => {
    const decision = decide(await evidenceFor([STORY, "playwright.config.ts"], tierConfig("on")));

    expect(decision).toMatchObject(VISUAL_ROW);
    expect(decision.reason).toContain("tier 2: harness: playwright.config.ts");
  });

  it("a logic head whose visual check concluded skipped stays tier 2, as only success counts", async () => {
    const decision = decide(await evidenceFor([HOOK], tierConfig("on"), [successRun("validate", 1), successRun("dag-check", 3), successRun("visual", 2, undefined, "skipped")]));

    expect(decision).toMatchObject(VISUAL_ROW);
    expect(decision.reason).toContain("tier 2: logic with visual not green at the head");
  });

  it.each([
    ["no entry", undefined],
    ["mode off", tierConfig("off")],
  ])("%s records no tier and keeps today's gate", async (_case, tier) => {
    const evidence = await evidenceFor([STORY, HOOK], tier);

    expect(decide(evidence)).toMatchObject(VISUAL_ROW);
    expect(evidence.record.visualTier).toBeUndefined();
  });

  it("an unreadable entry under any other mode records tier 2 in shadow and decides nothing", async () => {
    const evidence = await evidenceFor([STORY, HOOK], { mode: "maybe" });

    expect(decide(evidence)).toMatchObject(VISUAL_ROW);
    expect(evidence.record.visualTier).toMatchObject({ mode: "shadow", verdict: { tier: 2 } });
  });
});
