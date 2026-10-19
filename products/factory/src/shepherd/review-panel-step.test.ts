import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { DEFAULT_PANEL_POLICY, DEFAULT_PANEL_TABLE, planPanel, type PanelPlan, type PanelVerdict, type ReviewShape, type ReviewerAgent } from "@titan-design/review-panel";
import { describe, expect, it } from "vitest";
import { aggregatePanel, panelFindingsText, panelMerge, panelReviewerNames } from "./review-panel-step.js";
import { isOwnReviewer } from "./cleanup.js";
import { defectClassSection } from "./wake-brief.js";

const REPO = "octo/demo";
const HEAD = fakeSha("panel-head");
const POLICY = { ...DEFAULT_PANEL_POLICY, panel: DEFAULT_PANEL_TABLE };
/** g10 with a security and a perf touch: correctness and a blocking adversary, then an advisory perf member. */
const PLAN: PanelPlan = planPanel({ class: "g10", touches: ["security", "perf"] }, POLICY, { opus: true });

const reviewer = (shape: string) => ({ agentId: `agent-${shape}`, sessionId: `session-${shape}` });
/** A member's result as its await step records it, which is what the panel step reads. */
type Recorded = { shape: ReviewShape; result: object };
const verdict = (shape: ReviewShape, said: "MERGE" | "FIX_FIRST", text = ""): Recorded => ({
  shape,
  result: { kind: "verdict", verdict: said, head: HEAD, locator: { sourceId: shape }, reviewer: reviewer(shape), ...(said === "FIX_FIRST" && { text }) },
});
const none = (shape: ReviewShape): Recorded => ({ shape, result: { kind: "none" } });

/** What the sh-review-panel step records for these member results, with `files` readable at the head. */
async function aggregateStep(results: readonly Recorded[], files: Record<string, string> = {}, proof: { fixProof?: string; fixProofWaivedAt?: string } = {}): Promise<PanelVerdict> {
  const fake = fakeGitHub();
  for (const [path, content] of Object.entries(files)) fake.files.set(`${HEAD}:${path}`, { content, blobSha: fakeSha(path) });
  return aggregatePanel({ port: githubPort(fake.wire) }, JSON.parse(JSON.stringify({ repo: REPO, pr: 1, head: HEAD, plan: PLAN, results, ...proof })));
}

describe("the sh-review-panel step", () => {
  it("reads the owner's waiver at the head from the recorded input, and ignores one at another head", async () => {
    const results = [verdict("correctness", "MERGE"), verdict("adversary", "MERGE"), verdict("perf", "MERGE")];

    const waived = await aggregateStep(results, {}, { fixProof: "vacuous", fixProofWaivedAt: HEAD });
    const stale = await aggregateStep(results, {}, { fixProof: "vacuous", fixProofWaivedAt: fakeSha("older-head") });

    expect(waived.outcome).toBe("MERGE");
    expect(stale.outcome).toBe("no-verdict");
  });

  it("merges when every blocking member says MERGE at the head, and records who reviewed", async () => {
    const results = [verdict("correctness", "MERGE"), verdict("adversary", "MERGE"), verdict("perf", "MERGE")];

    const decided = await aggregateStep(results);

    expect(decided).toMatchObject({ outcome: "MERGE", satisfiesG10: true, dissent: [] });
    expect(panelMerge(decided, results).members.map(({ shape, agentId }) => [shape, agentId])).toEqual([
      ["correctness", "agent-correctness"],
      ["adversary", "agent-adversary"],
      ["perf", "agent-perf"],
    ]);
  });

  it("records what each member said, at which head, and the profile it was spawned at, for the two-MERGE release", async () => {
    const results = [verdict("correctness", "MERGE"), verdict("adversary", "MERGE"), verdict("perf", "MERGE")];

    const members = panelMerge(await aggregateStep(results), results, { adversary: "fable-reviewer" }).members;

    expect(members.find((member) => member.shape === "adversary")).toMatchObject({ verdict: "MERGE", head: HEAD, profile: "fable-reviewer", sessionId: "session-adversary" });
    expect(members.find((member) => member.shape === "perf")).not.toHaveProperty("profile");
  });

  it("sends the head back on a split panel, with each member's findings under its shape and the class last for the fixer's brief", async () => {
    const adversary = "Retries skip the token check.\n\nDefect class: unchecked retry path";

    const decided = await aggregateStep([verdict("correctness", "MERGE"), verdict("adversary", "FIX_FIRST", adversary), verdict("perf", "MERGE")]);
    const text = panelFindingsText(decided);

    expect(decided).toMatchObject({ outcome: "FIX_FIRST", dissent: ["adversary"], defectClass: "unchecked retry path" });
    expect(text).toContain("adversary (blocking):\nRetries skip the token check.");
    expect(defectClassSection(text)).toBe("Defect class: unchecked retry path");
  });

  it("gives no verdict when a blocking member is missing, however the others voted", async () => {
    const decided = await aggregateStep([verdict("correctness", "MERGE"), none("adversary"), verdict("perf", "MERGE")]);

    expect(decided).toMatchObject({ outcome: "no-verdict", satisfiesG10: false });
  });

  it("keeps an advisory finding whose citation reads at the head, and drops one citing a file the head lacks", async () => {
    const perf = "- The loop re-reads src/hot.ts:2 on every tick.\n- The cache in src/gone.ts:9 is never cleared.";

    const decided = await aggregateStep([verdict("correctness", "MERGE"), verdict("adversary", "MERGE"), verdict("perf", "FIX_FIRST", perf)], { "src/hot.ts": "one\ntwo\nthree\n" });

    expect(decided.outcome).toBe("MERGE");
    expect(decided.findings).toEqual([{ shape: "perf", text: "- The loop re-reads src/hot.ts:2 on every tick.", blocking: false }]);
  });
});

describe("panelReviewerNames", () => {
  const roster = (...names: string[]): ReviewerAgent[] => names.map((name) => ({ name, agentId: `agent-${name}`, sessionId: "", presence: "exited", spawnedBy: null }));

  const spawned = { repo: REPO, pr: 1, reviewer: "rv-octo-demo-1", mode: "spawn" };
  const standing = { repo: REPO, pr: 7, reviewer: "rv-standing", mode: "resume" };

  it("names each member but correctness after the spawned correctness reviewer, with its shape", () => {
    expect(panelReviewerNames(spawned, PLAN, roster())).toEqual({ adversary: "rv-octo-demo-1-adversary", perf: "rv-octo-demo-1-perf" });
  });

  it("skips a name an earlier agent holds, so a member is never adopted from another head", () => {
    expect(panelReviewerNames(spawned, PLAN, roster("rv-octo-demo-1-adversary"))).toMatchObject({ adversary: "rv-octo-demo-1-adversary-2" });
  });

  it("names a standing reviewer's members after this PR's base, so park and cleanup find them and no other PR's", () => {
    const names = panelReviewerNames(standing, PLAN, roster("rv-octo-demo-7-adversary"));

    expect(names).toEqual({ adversary: "rv-octo-demo-7-adversary-2", perf: "rv-octo-demo-7-perf" });
    expect(Object.values(names).every(isOwnReviewer(REPO, 7))).toBe(true);
    expect(Object.values(names).some(isOwnReviewer(REPO, 8))).toBe(false);
  });
});
